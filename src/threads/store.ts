import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import type { ChatEntry, ThreadMeta } from "../types";

const DEBOUNCE_MS = 500;

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(value));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      // Windows: rename over an existing/virus-scanned file can fail
      // transiently — retry a few times before surfacing the error.
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EEXIST") && attempt < 5) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

export class ThreadStore {
  private readonly index = new Map<string, ThreadMeta>();
  private readonly entries = new Map<string, ChatEntry[]>();
  private readonly dirtyEntries = new Set<string>();
  private indexDirty = false;
  private timer?: NodeJS.Timeout;
  private readonly savedImages = new Set<string>();

  constructor(private readonly dir: string) {}

  /** The on-disk root (index.json + threads/). */
  root(): string {
    return this.dir;
  }

  private file(id: string): string {
    return path.join(this.dir, "threads", `${id.replace(/[^\w.-]/g, "_")}.json`);
  }

  private imageDir(id: string): string {
    return `${this.file(id)}.images`;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(path.join(this.dir, "index.json"), "utf8");
      for (const t of JSON.parse(raw) as ThreadMeta[]) this.index.set(t.id, t);
    } catch {
      /* no index yet */
    }
  }

  list(): ThreadMeta[] {
    return [...this.index.values()];
  }

  get(id: string): ThreadMeta | undefined {
    return this.index.get(id);
  }

  async entriesOf(id: string): Promise<ChatEntry[]> {
    const cached = this.entries.get(id);
    if (cached) return cached;
    try {
      const e = JSON.parse(await fs.readFile(this.file(id), "utf8")) as ChatEntry[];
      const images: { part: Record<string, unknown>; ref: string }[] = [];
      JSON.stringify(e, (_key, value) => {
        if (value?.type === "image" && typeof value.imageRef === "string") {
          images.push({ part: value, ref: value.imageRef });
        }
        return value;
      });
      for (const { part, ref } of images) {
        try {
          if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error("Invalid image reference");
          part.data = JSON.parse(await fs.readFile(path.join(this.imageDir(id), `${ref}.json`), "utf8"));
          if (typeof part.data !== "string") throw new Error("Invalid image data");
          if (createHash("sha256").update(part.data).digest("hex") !== ref) throw new Error("Corrupt image data");
          delete part.imageRef;
        } catch {
          part.type = "text";
          part.text = "[Image unavailable]";
          delete part.data;
          delete part.imageRef;
          delete part.mimeType;
        }
      }
      this.entries.set(id, e);
      return e;
    } catch {
      const e: ChatEntry[] = [];
      this.entries.set(id, e);
      return e;
    }
  }

  /** Insert or replace a thread's meta; `entries` replaces the transcript too. */
  put(meta: ThreadMeta, entries?: ChatEntry[]): void {
    meta.updatedAt = meta.updatedAt || Date.now();
    this.index.set(meta.id, meta);
    this.indexDirty = true;
    if (entries) {
      this.entries.set(meta.id, entries);
      this.dirtyEntries.add(meta.id);
    }
    this.schedule();
  }

  updateMeta(id: string, patch: Partial<ThreadMeta>): void {
    const t = this.index.get(id);
    if (!t) return;
    this.index.set(id, { ...t, ...patch });
    this.indexDirty = true;
    this.schedule();
  }

  setEntries(id: string, entries: ChatEntry[]): void {
    this.entries.set(id, entries);
    this.dirtyEntries.add(id);
    this.schedule();
  }

  async delete(id: string): Promise<void> {
    this.index.delete(id);
    this.entries.delete(id);
    this.dirtyEntries.delete(id);
    // Run on the same tail as flushes so a queued write can't resurrect a
    // deleted thread or race the rm.
    return this.enqueue(async () => {
      await fs.rm(this.file(id), { force: true }).catch(() => undefined);
      await fs.rm(this.imageDir(id), { recursive: true, force: true });
      for (const key of this.savedImages) if (key.startsWith(`${id}/`)) this.savedImages.delete(key);
      await writeJsonAtomic(path.join(this.dir, "index.json"), this.list());
    });
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch((err) =>
        console.warn("[acp] thread store flush failed", err),
      );
    }, DEBOUNCE_MS);
  }

  /** All disk writes go through this tail — concurrent put/flush/delete
   *  calls serialize instead of racing index/entry writes. */
  private flushTail: Promise<void> = Promise.resolve();

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.flushTail.then(job);
    this.flushTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.enqueue(() => this.flushNow());
  }

  private async flushNow(): Promise<void> {
    if (this.indexDirty) {
      // Clear the flag BEFORE the await — a put/updateMeta landing mid-write
      // re-marks dirty and survives to the next flush; a failed write
      // restores it so the retry doesn't drop data.
      this.indexDirty = false;
      try {
        await writeJsonAtomic(path.join(this.dir, "index.json"), this.list());
      } catch (err) {
        this.indexDirty = true;
        console.warn("[acp] thread index write failed", err);
        throw err;
      }
    }
    for (const id of [...this.dirtyEntries]) {
      const e = this.entries.get(id);
      if (!e) {
        this.dirtyEntries.delete(id);
        continue;
      }
      // Same ordering as the index: unmark before the write so an update
      // arriving during it stays dirty; restore on failure for retry.
      this.dirtyEntries.delete(id);
      try {
        const images = new Map<string, string>();
        const stored = JSON.parse(JSON.stringify(e, (_key, value) => {
          if (value?.type !== "image" || typeof value.data !== "string") return value;
          const ref = createHash("sha256").update(value.data).digest("hex");
          images.set(ref, value.data);
          const { data: _data, ...rest } = value;
          return { ...rest, imageRef: ref };
        }));
        for (const [ref, data] of images) {
          const key = `${id}/${ref}`;
          if (this.savedImages.has(key)) continue;
          const file = path.join(this.imageDir(id), `${ref}.json`);
          try {
            await fs.access(file);
          } catch {
            await writeJsonAtomic(file, data);
          }
          this.savedImages.add(key);
        }
        await writeJsonAtomic(this.file(id), stored);
      } catch (err) {
        this.dirtyEntries.add(id);
        console.warn("[acp] thread entry write failed", err);
        throw err;
      }
    }
  }
}
