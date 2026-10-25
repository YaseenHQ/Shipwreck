import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fsp from "fs/promises";
import * as path from "path";
import type * as acp from "@agentclientprotocol/sdk";
import { diffHunks, diffStats } from "./diffstats";
import { currentTextIfExists, deleteFile, openDocument, writeFileBytes, writeTextFile } from "./acp/clientFs";
import type { Snapshot, Snapshotter } from "./snapshots";
import type { ChangedFile, ChatEntry } from "./types";

/** Larger files are listed but not kept for undo. */
const MAX_SNAPSHOT = 2 * 1024 * 1024;
const KEEP_RECORDS = 200;

/** Content before the turn: text, null when the file did not exist, undefined when unknown. */
type Before = string | null | undefined;

interface Tracked {
  path: string;
  before: Promise<Before>;
  /** Read before the edit ran, rather than rebuilt from a reported diff. */
  exact: boolean;
  /** Latest diff each tool call reported for this file, for stats when `before` is unknown. */
  diffs: Map<string, { oldText?: string | null; newText: string }>;
}

interface Turn {
  files: Map<string, Tracked>;
  /** Snapshots of the workspace folders as the turn started. */
  snaps: Promise<Snapshot[]>;
}

interface FileRecord {
  path: string;
  before?: Before;
  afterHash: string | null;
  /** Index into `snaps` when the original lives in a snapshot instead of `before`. */
  snap?: number;
  rel?: string;
  existed?: boolean;
}

export interface ChangeRecord {
  files: FileRecord[];
  snaps?: Snapshot[];
}

export type DiffUri = (label: string, content: string) => vscode.Uri;

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const fileKey = (p: string) => (caseInsensitive ? path.normalize(p).toLowerCase() : path.normalize(p));
const hash = (s: string | null) => (s === null ? null : crypto.createHash("sha1").update(s).digest("hex"));

async function snapshot(filePath: string): Promise<Before> {
  const text = await currentTextIfExists(filePath);
  return text === undefined ? null : text;
}

/** First seen after the edit ran: undo the reported replacement on the current text. */
async function reconstruct(
  filePath: string,
  diff: { oldText?: string | null; newText: string } | undefined,
): Promise<Before> {
  if (!diff) return undefined;
  const current = await currentTextIfExists(filePath);
  if (current === undefined) return undefined;
  if (diff.oldText == null) return current === diff.newText ? null : undefined;
  if (!diff.newText) return undefined;
  const parts = current.split(diff.newText);
  return parts.length === 2 ? parts.join(diff.oldText) : undefined;
}

/**
 * Records what files looked like before a turn changed them, so the turn's
 * changes can be reviewed side by side and undone. Workspace folders are
 * snapshotted with Git when the turn starts and ends, which catches every
 * edit however the agent made it (its own tools, terminal commands,
 * formatters). Files the client writes for the agent are also copied just
 * before the write, which covers files outside the snapshots.
 */
export class ChangeTracker {
  private readonly turns = new Map<string, Turn>();

  constructor(
    private readonly dir: string,
    private readonly snapshots?: Snapshotter,
    /** Folders to snapshot for a turn; empty turns snapshotting off. */
    private readonly roots: () => string[] = () => [],
  ) {}

  begin(sessionId: string): void {
    this.turns.set(sessionId, { files: new Map(), snaps: this.snapshotAll() });
  }

  private async snapshotAll(): Promise<Snapshot[]> {
    if (!this.snapshots) return [];
    const taken = await Promise.all(this.roots().map((r) => this.snapshots!.take(r).catch(() => undefined)));
    const seen = new Set<string>();
    return taken.filter((s): s is Snapshot => {
      if (!s) return false;
      const k = fileKey(s.store.workTree);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** Called before the client writes a file for the agent. */
  async beforeWrite(sessionId: string, filePath: string): Promise<void> {
    const t = this.turns.get(sessionId);
    if (!t) return;
    // The start snapshot must not see this write.
    await t.snaps;
    const k = fileKey(filePath);
    const known = t.files.get(k);
    if (known) {
      await known.before;
      return;
    }
    const tracked: Tracked = { path: filePath, before: snapshot(filePath), exact: true, diffs: new Map() };
    t.files.set(k, tracked);
    await tracked.before;
  }

  noteUpdate(sessionId: string, update: acp.SessionUpdate): void {
    const t = this.turns.get(sessionId);
    if (!t || (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")) return;
    const u = update as {
      toolCallId: string;
      kind?: string | null;
      status?: string | null;
      content?: { type: string; path?: string; oldText?: string | null; newText?: string }[] | null;
      locations?: { path: string }[] | null;
    };
    const touched = new Map<string, { oldText?: string | null; newText: string } | undefined>();
    for (const c of u.content ?? []) {
      if (c.type === "diff" && c.path) touched.set(c.path, { oldText: c.oldText, newText: c.newText ?? "" });
    }
    if (u.kind === "edit" || u.kind === "delete" || u.kind === "move") {
      for (const l of u.locations ?? []) if (!touched.has(l.path)) touched.set(l.path, undefined);
    }
    const ran = u.status === "completed" || u.status === "failed";
    for (const [p, diff] of touched) {
      if (!path.isAbsolute(p)) continue;
      const k = fileKey(p);
      let tracked = t.files.get(k);
      if (!tracked) {
        tracked = ran
          ? { path: p, before: reconstruct(p, diff), exact: false, diffs: new Map() }
          : { path: p, before: snapshot(p), exact: true, diffs: new Map() };
        t.files.set(k, tracked);
      }
      if (diff) tracked.diffs.set(u.toolCallId, diff);
    }
  }

  /** Ends the turn; returns its changes entry when any file ended up different. */
  async finish(sessionId: string): Promise<ChatEntry | undefined> {
    const t = this.turns.get(sessionId);
    this.turns.delete(sessionId);
    if (!t) return undefined;
    const snaps = await t.snaps;
    const files: ChangedFile[] = [];
    const record: ChangeRecord = { files: [], ...(snaps.length ? { snaps } : {}) };
    const handled = new Set<string>();

    for (let i = 0; i < snaps.length && this.snapshots; i++) {
      const after = await this.snapshots.take(snaps[i].store.workTree);
      if (!after) continue;
      const changed = await this.snapshots.diff(snaps[i], after).catch((err) => {
        console.warn("[acp] change snapshot diff failed", err);
        return [];
      });
      for (const c of changed) {
        const k = fileKey(c.path);
        if (t.files.get(k)?.exact || handled.has(k)) continue;
        handled.add(k);
        const now = await currentTextIfExists(c.path);
        files.push({ path: c.path, add: c.add, del: c.del, ...(c.status === "A" ? { created: true } : {}) });
        record.files.push({
          path: c.path,
          afterHash: hash(now === undefined ? null : now),
          snap: i,
          rel: c.rel,
          existed: c.status !== "A",
        });
      }
    }

    for (const tracked of t.files.values()) {
      if (handled.has(fileKey(tracked.path))) continue;
      const before = await tracked.before.catch(() => undefined);
      const afterText = await currentTextIfExists(tracked.path);
      const after = afterText === undefined ? null : afterText;
      if (before === after) continue;
      let stats: { add: number; del: number };
      if (before !== undefined) {
        stats = diffStats(diffHunks(before ?? "", after ?? ""));
      } else {
        if (!tracked.diffs.size) continue;
        stats = { add: 0, del: 0 };
        for (const d of tracked.diffs.values()) {
          const s = diffStats(diffHunks(d.oldText, d.newText));
          stats.add += s.add;
          stats.del += s.del;
        }
      }
      files.push({ path: tracked.path, ...stats, ...(before === null ? { created: true } : {}) });
      const keep = before === undefined || before === null || before.length <= MAX_SNAPSHOT;
      record.files.push({ path: tracked.path, before: keep ? before : undefined, afterHash: hash(after) });
    }
    if (!files.length) return undefined;
    const id = `changes-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    void this.save(id, record);
    return { id, kind: "changes", ts: Date.now(), files };
  }

  private async save(id: string, record: ChangeRecord): Promise<void> {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(path.join(this.dir, `${id}.json`), JSON.stringify(record));
      const names = (await fsp.readdir(this.dir)).filter((n) => n.endsWith(".json")).sort();
      // Ids start with a timestamp, so name order is age order.
      for (const old of names.slice(0, Math.max(0, names.length - KEEP_RECORDS))) {
        await fsp.unlink(path.join(this.dir, old)).catch(() => undefined);
      }
    } catch (err) {
      console.warn("[acp] could not save turn changes", err);
    }
  }

  async load(id: string): Promise<ChangeRecord | undefined> {
    if (!/^changes-[\w-]+$/.test(id)) return undefined;
    try {
      return JSON.parse(await fsp.readFile(path.join(this.dir, `${id}.json`), "utf8")) as ChangeRecord;
    } catch {
      return undefined;
    }
  }

  private canRestore(f: FileRecord): boolean {
    return f.before !== undefined || (f.snap !== undefined && !!this.snapshots);
  }

  /** The file's bytes before the turn: null when it did not exist, undefined when unknown. */
  private async beforeBytes(record: ChangeRecord, f: FileRecord): Promise<Uint8Array | null | undefined> {
    if (f.snap === undefined) return f.before == null ? f.before : Buffer.from(f.before, "utf8");
    if (!f.existed) return null;
    const snap = record.snaps?.[f.snap];
    if (!snap || !this.snapshots || !f.rel) return undefined;
    return (await this.snapshots.read(snap, f.rel)) ?? undefined;
  }

  /** Opens the turn's changes: one file in the diff editor, several in the multi-file diff. */
  async review(record: ChangeRecord, diffUri: DiffUri, onlyPath?: string): Promise<void> {
    const tuples: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
    for (const f of pick(record, onlyPath)) {
      const name = path.basename(f.path);
      const file = vscode.Uri.file(f.path);
      const bytes = await this.beforeBytes(record, f).catch(() => undefined);
      const text = bytes == null ? bytes : Buffer.from(bytes).toString("utf8");
      if (text === undefined || (text !== null && text.includes("\u0000"))) {
        tuples.push([file, file, file]);
        continue;
      }
      const left = diffUri(`${name} (before)`, text ?? "");
      const exists = (await currentTextIfExists(f.path)) !== undefined;
      tuples.push([file, left, exists ? file : diffUri(`${name} (deleted)`, "")]);
    }
    if (!tuples.length) return;
    if (tuples.length === 1) {
      const [file, left, right] = tuples[0];
      if (left === right) {
        if ((await currentTextIfExists(file.fsPath)) !== undefined) await vscode.window.showTextDocument(file, { preview: true });
        return;
      }
      await vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(file.fsPath)} (agent changes)`, {
        preview: true,
      });
      return;
    }
    try {
      await vscode.commands.executeCommand("vscode.changes", `Agent changes (${tuples.length} files)`, tuples);
    } catch {
      const [, left, right] = tuples[0];
      await vscode.commands.executeCommand("vscode.diff", left, right);
    }
  }

  /** Restores files to their content before the turn, after asking. Returns the paths restored. */
  async revert(record: ChangeRecord, onlyPath?: string): Promise<string[]> {
    return this.restore(record, onlyPath, "this turn");
  }

  async reviewMany(records: ChangeRecord[], diffUri: DiffUri, onlyPath?: string): Promise<void> {
    await this.review(combine(records), diffUri, onlyPath);
  }

  async revertMany(records: ChangeRecord[], onlyPath?: string): Promise<string[]> {
    return this.restore(combine(records), onlyPath, "these outstanding agent edits");
  }

  private async restore(record: ChangeRecord, onlyPath: string | undefined, scope: string): Promise<string[]> {
    const targets = pick(record, onlyPath);
    const doable = targets.filter((f) => this.canRestore(f));
    if (!doable.length) {
      void vscode.window.showWarningMessage(
        "These changes can't be undone automatically: the original content of the files wasn't recorded.",
      );
      return [];
    }
    const edited: string[] = [];
    for (const f of doable) {
      const now = await currentTextIfExists(f.path);
      if (hash(now === undefined ? null : now) !== f.afterHash) edited.push(path.basename(f.path));
    }
    const what = doable.length === 1 ? path.basename(doable[0].path) : `${doable.length} files`;
    const detail = [
      `Files go back to how they were before ${scope}. Open editors can undo this with Ctrl+Z.`,
      edited.length ? `Changed since the agent's edits: ${edited.join(", ")}. Those later edits will be lost.` : "",
      targets.length > doable.length ? `${targets.length - doable.length} file(s) can't be undone automatically.` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const ok = await vscode.window.showWarningMessage(`Undo the agent's changes to ${what}?`, { modal: true, detail }, "Undo");
    if (ok !== "Undo") return [];
    const done: string[] = [];
    for (const f of doable) {
      try {
        const bytes = await this.beforeBytes(record, f);
        if (bytes === undefined) throw new Error("the original is no longer stored");
        if (bytes === null) await deleteFile(f.path);
        else if (f.snap === undefined || openDocument(f.path)) await writeTextFile(f.path, Buffer.from(bytes).toString("utf8"));
        else await writeFileBytes(f.path, bytes);
        done.push(f.path);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Could not restore ${path.basename(f.path)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return done;
  }
}

/** Records arrive oldest first. Keep the first baseline and the last post-edit hash. */
function combine(records: ChangeRecord[]): ChangeRecord {
  const files = new Map<string, FileRecord>();
  const snaps: Snapshot[] = [];
  for (const record of records) {
    const offset = snaps.length;
    snaps.push(...(record.snaps ?? []));
    for (const f of record.files) {
      const key = fileKey(f.path);
      const first = files.get(key);
      if (first) first.afterHash = f.afterHash;
      else files.set(key, { ...f, snap: f.snap === undefined ? undefined : offset + f.snap });
    }
  }
  return { files: [...files.values()], snaps };
}

function pick(record: ChangeRecord, onlyPath?: string): FileRecord[] {
  return onlyPath ? record.files.filter((f) => fileKey(f.path) === fileKey(onlyPath)) : record.files;
}
