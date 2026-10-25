import * as vscode from "vscode";
import * as crypto from "crypto";
import * as path from "path";
import * as fsp from "fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import { AgentConnection, ClientDelegate, PermissionRequest } from "./acp/connection";
import { InsertedPromptFailed } from "./acp/v2/adapter";
import { AgentPool, PooledConnection } from "./acp/pool";
import { TerminalManager } from "./acp/terminalManager";
import { disposeTiming, logTiming, Stopwatch } from "./timing";
import { Installer } from "./installer";
import { RegistryService } from "./registry";
import { SessionModel, toConfigOptionInfos } from "./sessionModel";
import { ModelCatalog, modelOption } from "./agentModels";
import { ThreadStore } from "./threads/store";
import { ChangeTracker } from "./changes";
import { Snapshotter } from "./snapshots";
import { parseFileRef, resolveFileRef } from "./fileRefs";
import { attachmentFromBytes, attachmentSizeError, imageMimeType } from "./attachments";
import { buildPrompt } from "./promptAttachments";
import { EditorContextTracker } from "./editorContext";
import { IdeToolsServer, IDE_SERVER_NAME } from "./ide/server";
import {
  buildHandoff,
  buildTranscript,
  HANDOFF_BUDGET_BYTES,
} from "./threads/handoff";
import {
  AgentDescriptor,
  Attachment,
  ChatEntry,
  ConnectionStatus,
  HostMessage,
  Part,
  SessionMeta,
  SessionSummary,
  Snapshot,
  ThreadActivity,
  ThreadMeta,
  TerminalSnapshot,
  WebviewMessage,
  WorkspaceInfo,
} from "./types";

type AppendMessage = Extract<HostMessage, { type: "entryAppend" }>;
const APPEND_FLUSH_MS = 16;
const PROBE_DELAY_MS = 5_000;
/** Each probe starts an agent process, so only a few run at once. */
const PROBE_CONCURRENCY = 2;

interface PendingPermission {
  entryId: string;
  resolve: (r: acp.RequestPermissionResponse) => void;
}

interface PendingElicitation {
  entryId: string;
  elicitationId?: string;
  resolve: (r: acp.CreateElicitationResponse) => void;
}

/** The turn allowed to advance coveredEntries once it completes. Streaming never advances it. */
interface TurnOwner {
  /** Generation that owns the turn; re-stamped when a background turn is brought back. */
  token: number;
  agentId: string;
  sessionId: string;
  threadId: string;
  complete: boolean;
}

/** An accepted prompt that is still running, on screen or in the background. */
interface RunningTurn {
  lock: object;
  session: SessionMeta;
  model: SessionModel;
  owner: TurnOwner;
}

type SwitchWhileRunning = "keepRunning" | "ask";

function workspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

interface GitRepoState {
  HEAD?: { name?: string };
  onDidChange?: (fn: () => void) => vscode.Disposable;
}
interface GitRepo {
  rootUri: { fsPath: string };
  state: GitRepoState;
}

function isSessionNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    /session (\S+ )?not found|unknown session|no such session/i.test(err.message)
  );
}

/** Stamp which agent produced an entry — thread handoffs need it. */
function stampAgent(entry: ChatEntry, agentId: string): void {
  if (
    (entry.kind === "agent" || entry.kind === "tool" || entry.kind === "plan") &&
    !entry.agentId
  ) {
    entry.agentId = agentId;
  }
}

function isAuthRequired(err: unknown): boolean {
  return (
    err instanceof acp.RequestError && err.code === -32000
  ) || (err instanceof Error && /auth/i.test(err.message) && /required/i.test(err.message));
}

function stopReasonNotice(stopReason?: string): string | undefined {
  switch (stopReason) {
    case "refusal":
      return "The agent declined this request.";
    case "max_tokens":
      return "The agent hit its output limit. Send a message to continue.";
    case "max_turn_requests":
      return "The agent hit its request limit for this turn. Send a message to continue.";
    default:
      return undefined;
  }
}

export class ChatController implements ClientDelegate, vscode.Disposable {
  private readonly terminals = new TerminalManager((snapshot, sessionId) => {
    void this.onTerminalOutput(snapshot, sessionId).catch((err) =>
      console.warn("[acp] terminal output update failed", err),
    );
  });
  private readonly terminalThreads = new Map<string, string>();
  private readonly pool = new AgentPool(
    (agentId) => new AgentConnection(this.delegateFor(agentId), this.terminals),
    undefined,
    (agentId) => this.hasBackgroundTurn(agentId),
  );
  /** The active agent's connection; other agents stay alive in the pool. */
  private get connection(): PooledConnection {
    return this.pool.connection(this.activeAgentId);
  }
  /** Measures time to the first agent update of the current turn. */
  private promptTiming: { sessionId: string; sw: Stopwatch; seen: boolean } | undefined;
  private model = new SessionModel();
  /** Entries array last published in a snapshot; unchanged arrays aren't resent. */
  private snapshotEntries: ChatEntry[] | undefined;
  /** Turns that kept running after the user moved on, by session id. */
  private readonly background = new Map<string, RunningTurn>();
  private readonly activity = new Map<string, ThreadActivity>();
  private readonly models: ModelCatalog;
  /** Sessions opened while probing, handed to that agent's next new chat. */
  private readonly spares = new Map<string, SessionMeta>();
  private readonly probes = new Map<string, Promise<void>>();
  /** Process starts begun by a probe; switching to that agent waits for them. */
  private readonly probeStarts = new Map<string, Promise<unknown>>();
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Applying the agent's preferred model to a session that was just created. */
  private preferredApply: Promise<void> | undefined;
  /** The accepted on-screen turn; a context switch moves it to `background`. */
  private runningTurn: RunningTurn | undefined;
  private readonly changes: ChangeTracker;
  /** Editor context tools offered to every session as an MCP server. */
  private readonly ide: IdeToolsServer;

  private views = new Set<vscode.Webview>();
  private appendQueue: AppendMessage[] = [];
  private appendTimer: ReturnType<typeof setTimeout> | undefined;
  private disposables: vscode.Disposable[] = [];

  private session: SessionMeta | null = null;
  private connectionStatus: ConnectionStatus = "disconnected";
  private connectionDetail: string | undefined;
  private activeAgentId: string | null;
  private activeThreadId: string | undefined;
  private pendingAgentId: string | undefined;
  private readonly nativeSessionsByAgent = new Map<string, SessionSummary[]>();
  private readonly threadStore: ThreadStore;
  /** session/load replays we're intentionally discarding (transcript is ours). */
  private readonly suppressReplay = new Set<string>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingElicitations = new Map<string, PendingElicitation>();
  private requestCounter = 0;
  private connectToken = 0;
  /** Agent whose transport finished initialize on the current generation —
   *  init/auth/caps are only ever published for this id. */
  private initializedAgentId: string | undefined;
  private didAutoConnect = false;
  private restartTimes: number[] = [];
  private gitSub: vscode.Disposable | undefined;
  private gitSubRepo: string | undefined;

  private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>();
  readonly onDidUpdate = this.onDidUpdateEmitter.event;

  /** Which webview view the chat lives in (secondary sidebar vs activity bar). */
  chatViewId = "shipwreck.chat";
  private chatVisible = false;

  setChatVisible(v: boolean): void {
    this.chatVisible = v;
  }

  /** An approval is waiting in the thread on screen. */
  get needsApproval(): boolean {
    for (const id of [...this.pendingPermissions.keys(), ...this.pendingElicitations.keys()]) {
      if (!this.backgroundTurnOf(id)) return true;
    }
    return false;
  }

  get busyNow(): boolean {
    return !!this.session?.busy;
  }

  agentDisplayName(id?: string): string {
    const key = id ?? this.activeAgentId;
    return this.installer.descriptors().find((a) => a.id === key)?.name ?? key ?? "Agent";
  }

  async focusChat(): Promise<void> {
    // The view the user actually has can differ from the one picked at
    // activation (a layout saved by another version, or a moved view), and a
    // view whose `when` clause is false has no focus command at all.
    const other = this.chatViewId === "shipwreck.chat" ? "shipwreck.chatSecondary" : "shipwreck.chat";
    for (const cmd of [`${this.chatViewId}.focus`, `${other}.focus`]) {
      try {
        await vscode.commands.executeCommand(cmd);
        return;
      } catch {
        /* try the next location */
      }
    }
    if (!this.views.size) this.openPanelFallback?.();
  }

  /** Opens the chat as an editor tab when no sidebar view can be focused. */
  openPanelFallback: (() => void) | undefined;

  /** Post attachments to the composer and focus it (opens the view if needed). */
  async addAttachments(atts: Attachment[]): Promise<void> {
    if (!atts.length) return;
    await this.focusChat();
    for (const attachment of atts) {
      this.post({ type: "attachment", attachment: this.editorContext.enrich(attachment) });
    }
    this.post({ type: "focusComposer" });
  }

  private readonly editorContext: EditorContextTracker;

  /** Fuzzy-ish workspace file search for @-mentions. */
  async mentionSearch(query: string): Promise<void> {
    const files = await vscode.workspace.findFiles("**/*", undefined, 200);
    const q = query.trim().toLowerCase();
    const scored: { uri: vscode.Uri; name: string; path: string; s: number }[] = [];
    for (const uri of files) {
      const rel = vscode.workspace.asRelativePath(uri, false);
      const name = path.basename(rel);
      const hay = `${name}\n${rel}`.toLowerCase();
      let s = 0;
      if (q) {
        let i = -1;
        let ok = true;
        for (const ch of q) {
          i = hay.indexOf(ch, i + 1);
          if (i < 0) { ok = false; break; }
        }
        if (!ok) continue;
        s = name.toLowerCase().startsWith(q) ? 0 : rel.toLowerCase().includes(`/${q}`) ? 1 : 2;
      }
      scored.push({ uri, name, path: rel, s });
    }
    scored.sort((a, b) => a.s - b.s || a.path.localeCompare(b.path));
    this.post({
      type: "mentionResults",
      results: scored.slice(0, 50).map(({ uri, name, path }) => ({
        uri: uri.toString(),
        name,
        path,
      })),
    });
  }

  /** Resolve uri strings (drops) into composer attachments. */
  async attachUris(uris: string[]): Promise<void> {
    const atts: Attachment[] = [];
    for (const raw of uris) {
      try {
        const uri = vscode.Uri.parse(raw);
        if (uri.scheme !== "file") continue;
        const stat = await vscode.workspace.fs.stat(uri).then(
          (s) => s,
          () => undefined,
        );
        if (!stat) continue;
        const att: Attachment = {
          uri: uri.toString(),
          name: path.basename(uri.fsPath),
          kind: stat.type === vscode.FileType.Directory ? "folder" : "file",
        };
        if (att.kind === "file" && imageMimeType(att.name)) {
          const error = attachmentSizeError(stat.size, true);
          atts.push(error
            ? { ...att, kind: "rejected", error }
            : attachmentFromBytes(att.uri, att.name, await vscode.workspace.fs.readFile(uri)));
        } else {
          atts.push(att);
        }
      } catch {
        /* skip unparsable uri */
      }
    }
    await this.addAttachments(atts);
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: RegistryService,
    private readonly installer: Installer,
  ) {
    this.activeAgentId =
      context.globalState.get<string>("shipwreck.lastAgent") ||
      vscode.workspace.getConfiguration("shipwreck").get<string>("defaultAgent") ||
      null;
    this.threadStore = new ThreadStore(
      path.join(context.globalStorageUri.fsPath, "threads"),
    );
    this.models = new ModelCatalog(context.globalState, () => this.postModels());
    this.changes = new ChangeTracker(
      path.join(context.globalStorageUri.fsPath, "changes"),
      new Snapshotter(path.join(context.globalStorageUri.fsPath, "snapshots"), this.findGit),
      () => (vscode.workspace.getConfiguration("shipwreck").get<boolean>("changeSnapshots", true) ? workspaceRoots() : []),
    );
    this.ide = new IdeToolsServer(
      path.join(context.extensionPath ?? "", "dist", "ideBridge.js"),
      String(vscode.extensions.getExtension("yaseen.shipwreck")?.packageJSON?.version ?? "0.0.0"),
    );
    this.disposables.push(this.terminals, this.ide);
    this.editorContext = new EditorContextTracker((message) => this.post(message));
    this.disposables.push(this.editorContext);
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        // Spare sessions were opened for the old folders.
        this.spares.clear();
        this.postWorkspace();
      }),
    );
  }

  async init(): Promise<void> {
    await this.threadStore.load();
    this.reconcileAgents();
    this.postSnapshot();
  }

  /* ================= webview plumbing ================= */

  bind(webview: vscode.Webview, viewType?: string): void {
    this.views.add(webview);
    webview.onDidReceiveMessage((m: WebviewMessage) => {
      if (m.type !== "route") return void this.onMessage(m, webview);
      // Title-bar buttons swap to their filled "close" variant while their screen is open.
      if (viewType) void vscode.commands.executeCommand("setContext", `${viewType}Route`, m.view);
    });
    void this.postSnapshot(webview);
    this.editorContext.publish(true);
    this.autoConnect();
  }

  /** Start the last-used agent before the chat is opened, so the first view finds a live session. */
  prewarm(): void {
    // Only for people who have used an agent here; activation alone must not spawn one.
    if (!this.context.globalState.get<string>("shipwreck.lastAgent")) return;
    this.autoConnect();
    // Let the last-used agent start first; the others only feed the model picker.
    this.probeTimer = setTimeout(() => this.probeAgents(), PROBE_DELAY_MS);
    this.probeTimer.unref?.();
  }

  private autoConnect(): void {
    if (this.didAutoConnect) return;
    this.didAutoConnect = true;
    if (this.connectionStatus !== "disconnected") return;
    const installed = this.installer.descriptors().filter((a) => a.installed);
    const target = installed.find((a) => a.id === this.activeAgentId)?.id;
    if (target) void this.selectAgent(target);
  }

  unbind(webview: vscode.Webview): void {
    this.views.delete(webview);
    this.editorContext.unwatch(webview);
  }

  private post(msg: HostMessage, target?: vscode.Webview): void {
    if (msg.type === "entryAppend" && !target) {
      this.queueAppend(msg);
      return;
    }
    this.flushAppends();
    if (msg.type === "session" && msg.session) {
      this.pool.remember(msg.session);
      this.models.noteOptions(msg.session.agentId, msg.session.configOptions);
    }
    for (const v of target ? [target] : [...this.views]) this.send(v, msg);
  }

  private send(v: vscode.Webview, msg: unknown): void {
    try {
      v.postMessage(msg).then(undefined, () => this.views.delete(v));
    } catch {
      // A disposed webview throws instead of rejecting.
      this.views.delete(v);
    }
  }

  /** Text deltas for the same part merge until the next frame, so a fast
   *  stream costs one webview message per frame instead of one per token. */
  private queueAppend(msg: AppendMessage): void {
    const last = this.appendQueue[this.appendQueue.length - 1];
    if (
      last &&
      last.sessionId === msg.sessionId &&
      last.entryId === msg.entryId &&
      last.partIndex === msg.partIndex
    ) {
      last.text += msg.text;
    } else {
      this.appendQueue.push({ ...msg });
    }
    this.appendTimer ??= setTimeout(() => this.flushAppends(), APPEND_FLUSH_MS);
  }

  private flushAppends(): void {
    if (this.appendTimer) {
      clearTimeout(this.appendTimer);
      this.appendTimer = undefined;
    }
    if (!this.appendQueue.length) return;
    const queued = this.appendQueue;
    this.appendQueue = [];
    for (const m of queued) for (const v of [...this.views]) this.send(v, m);
  }

  private postSnapshot(target?: vscode.Webview, entries: "changed" | "full" = "changed"): void {
    // Only publish init/caps/auth while the live transport belongs to the
    // active agent — connecting generations and stale transports expose
    // nothing, auth_required keeps them (sign-in banner needs methods).
    const init =
      this.initializedAgentId === this.activeAgentId &&
      this.initializedAgentId !== undefined
        ? this.connection.initResponse
        : undefined;
    const caps = init?.agentCapabilities;
    // Entries travel as upserts/appends; a snapshot repeats them only when
    // the array was replaced or a view is joining.
    const withEntries = entries === "full" || target !== undefined || this.model.entries !== this.snapshotEntries;
    if (target === undefined) this.snapshotEntries = this.model.entries;
    this.post(
      {
        type: "snapshot",
        payload: {
          activeAgentId: this.activeAgentId,
          workspace: this.workspaceSnapshot(),
          prefs: this.context.globalState.get<Record<string, unknown>>("shipwreck.prefs", {}),
          agents: this.agentList(),
          connection: { status: this.connectionStatus, detail: this.connectionDetail },
          authMethods: (init?.authMethods ?? []).map((m) => ({
            id: m.id,
            name: m.name,
            description: m.description ?? undefined,
            type: "type" in m && m.type === "terminal" ? "terminal" : "agent",
          })),
          session: this.session,
          entries: withEntries ? this.model.entries : undefined,
          activity: [...this.activity.values()],
          agentModels: this.models.list(),
          threads: this.threadStore.list(),
          nativeSessions: this.sessionList(),
          activeThreadId: this.activeThreadId,
          threadsScope: vscode.workspace
            .getConfiguration("shipwreck")
            .get<"workspace" | "all">("threads.scope", "workspace"),
          threadsImport: vscode.workspace
            .getConfiguration("shipwreck")
            .get<boolean>("threads.importFromAgents", true),
          showCost: vscode.workspace.getConfiguration("shipwreck").get<boolean>("showCost", false),
          pendingAgentId: this.pendingAgentId,
          canLoadSession: !!caps?.loadSession,
          canListSessions: !!caps?.sessionCapabilities?.list,
          promptCapabilities: caps?.promptCapabilities
            ? {
                image: !!caps.promptCapabilities.image,
                audio: !!caps.promptCapabilities.audio,
                embeddedContext: !!caps.promptCapabilities.embeddedContext,
              }
            : undefined,
        } satisfies Snapshot,
      },
      target,
    );
    this.onDidUpdateEmitter.fire();
  }

  /** Workspace folders + current git branch for the composer's context line. */
  private workspaceSnapshot(): WorkspaceInfo | undefined {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({
      name: f.name,
      path: f.uri.fsPath,
    }));
    if (!folders.length) return undefined;
    const ws: WorkspaceInfo = { folders };
    try {
      const git = (
        vscode.extensions.getExtension("vscode.git")?.exports as
          | { getAPI(v: 1): { repositories: GitRepo[] } }
          | undefined
      )?.getAPI(1);
      const first = folders[0].path.toLowerCase();
      const repo = git?.repositories?.find((r) =>
        first.startsWith(r.rootUri.fsPath.toLowerCase()),
      );
      const branch = repo?.state?.HEAD?.name;
      if (branch) ws.branch = branch;
      const key = repo ? repo.rootUri.fsPath : undefined;
      if (key !== this.gitSubRepo) {
        this.gitSub?.dispose();
        this.gitSubRepo = key;
        this.gitSub = repo?.state?.onDidChange?.(() => this.postWorkspace());
      }
    } catch {
      /* git extension missing or not activated — no branch */
    }
    return ws;
  }

  private postWorkspace(): void {
    this.post({ type: "workspace", workspace: this.workspaceSnapshot() });
  }

  private toast(level: "info" | "warning" | "error", text: string): void {
    const fn =
      level === "error"
        ? vscode.window.showErrorMessage
        : level === "warning"
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
    void fn(text);
  }

  /* ================= agent lifecycle ================= */

  private setConnection(status: ConnectionStatus, detail?: string): void {
    this.connectionStatus = status;
    this.connectionDetail = detail;
    if (this.activeAgentId) {
      this.post({ type: "connection", agentId: this.activeAgentId, status, detail });
    }
    this.postSnapshot();
  }

  /** Spawn/connect an agent without creating a session.
   *  `token` is the caller's selection generation; standalone spawns claim a
   *  fresh one (invalidating any in-flight generation). */
  private spawnInflight:
    | { agentId: string; token: number; promise: Promise<boolean> }
    | undefined;

  private async spawn(agentId: string, token?: number): Promise<boolean> {
    const t = token ?? ++this.connectToken;
    // Webview messages aren't serialized — a send can arrive while a switch
    // is still spawning. Concurrent spawns of the same agent + generation
    // coalesce; different generations race and the newer token wins.
    if (
      this.spawnInflight?.agentId === agentId &&
      this.spawnInflight?.token === t
    ) {
      return this.spawnInflight.promise;
    }
    const promise = this.spawnInner(agentId, t);
    this.spawnInflight = { agentId, token: t, promise };
    try {
      return await promise;
    } finally {
      if (this.spawnInflight?.promise === promise) this.spawnInflight = undefined;
    }
  }

  private async spawnInner(agentId: string, token: number): Promise<boolean> {
    this.activeAgentId = agentId;
    this.pool.setActive(agentId);
    this.initializedAgentId = undefined;
    void this.context.globalState.update("shipwreck.lastAgent", agentId);
    const probing = this.probeStarts.get(agentId);
    if (probing) {
      // Starting again would kill the probe's process; use it instead.
      await probing.catch(() => undefined);
      if (token !== this.connectToken) return false;
    }
    if (this.connection.connected) {
      logTiming(`start ${agentId}: reused live process`);
      this.initializedAgentId = agentId;
      const info = this.connection.initResponse?.agentInfo;
      this.setConnection("connected", info?.title ?? info?.name);
      return true;
    }
    // Announce "connecting" before resolving the launch spec so the webview
    // never sees the previous agent's init/auth/caps under the new id.
    this.setConnection("connecting");
    const sw = new Stopwatch(`start ${agentId}`);
    try {
      const spec = await this.installer.launchSpec(agentId);
      // A stale launchSpec must not start a process for a retired selection
      // — check before AND after the await.
      if (token !== this.connectToken) return false;
      sw.lap("launch spec");
      if (this.connectionStatus === "connecting") {
        this.setConnection("connecting", spec.description);
      }
      const init = await this.pool.start(agentId, spec, workspaceCwd());
      if (token !== this.connectToken) return false;
      sw.lap("initialize");
      this.initializedAgentId = agentId;
      this.setConnection("connected", init.agentInfo?.title ?? init.agentInfo?.name);
      return true;
    } catch (err) {
      if (token !== this.connectToken) return false;
      this.initializedAgentId = undefined;
      const msg = err instanceof Error ? err.message : String(err);
      this.setConnection("error", msg);
      this.toast("error", `Could not start agent: ${msg}`);
      return false;
    }
  }

  async selectAgent(agentId: string): Promise<void> {
    if (!this.installer.descriptors().some((a) => a.id === agentId && a.installed)) {
      this.notifyAgentsChanged();
      return;
    }
    // Same agent already selected with a live, healthy session — nothing to
    // do. auth_required is NOT a no-op: the session may be stale.
    if (
      agentId === this.activeAgentId &&
      this.connectionStatus === "connected" &&
      this.connection.connected &&
      this.session?.agentId === agentId &&
      !this.pendingAgentId
    ) {
      return;
    }
    // A running turn keeps its thread; the new agent starts a fresh one.
    if (!(await this.yieldForeground())) return;
    if (this.needsApproval) {
      this.toast("info", "Respond to the pending approval before switching agents.");
      return;
    }
    const token = ++this.connectToken;
    // Flush the current transcript before retiring any context.
    this.persistThread(false);
    void this.threadStore.flush().catch((err) =>
      console.warn("[acp] thread flush before switch failed", err),
    );

    const meta = this.activeThreadId
      ? this.threadStore.get(this.activeThreadId)
      : undefined;
    if (meta && this.model.entries.length > 0) {
      // Switching agents while a thread with entries is open keeps the
      // thread — the new agent takes over via context handoff.
      this.pendingAgentId = agentId;
      this.session = null;
      this.post({ type: "session", session: null });
      this.postSnapshot();
      if (agentId !== this.activeAgentId || !this.connection.connected) {
        if (!(await this.spawn(agentId, token))) {
          // Keep the thread and the selected target — retryable.
          this.postSnapshot();
          return;
        }
      }
      if (token !== this.connectToken) return;
      // Attach now: resume an existing backing or session/new to surface
      // auth state up front rather than on first send.
      await this.resolveThreadSession(meta, token);
      this.postSnapshot();
      if (token === this.connectToken && this.listCapable) void this.listNativeSessions();
      return;
    }

    this.pendingAgentId = undefined;
    if (
      agentId === this.activeAgentId &&
      this.connection.connected &&
      this.connectionStatus !== "auth_required"
    ) {
      // Same agent, no session yet — just create one (no new-chat reset).
      if (!this.session) await this.createSession(token);
      this.postSnapshot();
      return;
    }
    this.model.reset();
    this.session = null;
    if (!(await this.spawn(agentId, token))) return;
    if (token !== this.connectToken) return;
    await this.createSession(token);
    if (
      token === this.connectToken &&
      this.connection.initResponse?.agentCapabilities?.sessionCapabilities?.list
    ) {
      void this.listNativeSessions();
    }
  }

  private mcpServers(): acp.McpServer[] {
    const configured = vscode.workspace
      .getConfiguration("shipwreck")
      .get<Record<string, { command: string; args?: string[]; env?: Record<string, string> }>>(
        "mcpServers",
        {},
      );
    const servers: acp.McpServer[] = Object.entries(configured).map(([name, s]) => ({
      name,
      command: s.command,
      args: s.args ?? [],
      env: Object.entries(s.env ?? {}).map(([n, value]) => ({ name: n, value })),
    }));
    const ideTools = vscode.workspace.getConfiguration("shipwreck").get<boolean>("ideTools", true);
    if (ideTools && !servers.some((s) => s.name === IDE_SERVER_NAME)) {
      servers.push(this.ide.mcpServer());
    }
    return servers;
  }

  /** A session's MCP servers are fixed when it is created or re-attached.
   *  After a settings change the idle on-screen session re-attaches now, a
   *  running one when its turn ends, and pooled ones when next opened. */
  mcpServersChanged(): void {
    this.pool.forgetAllSessions();
    if (this.promptInFlight) {
      // A queued transport restart re-attaches anyway.
      this.pendingRestart ??= () => void this.reattachForeground();
      return;
    }
    void this.reattachForeground();
  }

  private async reattachForeground(): Promise<void> {
    const session = this.session;
    if (!session || !this.connection.connected || this.connectionStatus !== "connected") return;
    const meta = this.activeThreadId ? this.threadStore.get(this.activeThreadId) : undefined;
    if (!meta) {
      // A draft has no transcript to keep.
      await this.newSession();
      return;
    }
    const backing = meta.backing.find(
      (b) => b.agentId === session.agentId && b.sessionId === session.sessionId,
    );
    if (!backing) return;
    const token = ++this.connectToken;
    this.session = null;
    await this.attachThreadSession(meta, backing, token);
    if (token === this.connectToken) this.postSnapshot();
  }

  private sessionInflight:
    | { agentId: string; token: number; promise: Promise<boolean> }
    | undefined;

  /** session/new without touching thread state. Returns success. A send that
   *  arrives while a selection is still opening its session joins that
   *  request instead of minting a second session that would replace it. */
  private createSession(token = this.connectToken): Promise<boolean> {
    const agentId = this.activeAgentId;
    const inflight = this.sessionInflight;
    if (inflight && inflight.agentId === agentId && inflight.token === token) return inflight.promise;
    const promise = this.createSessionInner(token);
    if (agentId) this.sessionInflight = { agentId, token, promise };
    void promise.finally(() => {
      if (this.sessionInflight?.promise === promise) this.sessionInflight = undefined;
    });
    return promise;
  }

  private async createSessionInner(token: number): Promise<boolean> {
    if (token !== this.connectToken) return false;
    const agentId = this.activeAgentId!;
    const spare = this.takeSpare(agentId);
    if (spare) {
      logTiming(`session/new ${agentId}: used the session opened while probing`);
      this.session = { ...spare, busy: false, createdAt: Date.now() };
      this.post({ type: "session", session: this.session });
      this.preferredApply = this.applyPreferredModel(token);
      return true;
    }
    const sw = new Stopwatch(`session/new ${agentId}`);
    try {
      const res = await this.connection.request(
        acp.methods.agent.session.new,
        {
          cwd: workspaceCwd(),
          additionalDirectories: workspaceRoots().slice(1),
          mcpServers: this.mcpServers(),
        },
        { cancellationSignal: AbortSignal.timeout(30_000) },
      );
      if (token !== this.connectToken) return false;
      sw.lap("ready");
      this.pool.markAttached(agentId, res.sessionId);
      this.session = {
        sessionId: res.sessionId,
        agentId,
        cwd: workspaceCwd(),
        modes: res.modes ?? null,
        configOptions: toConfigOptionInfos(res.configOptions ?? []),
        // Shown until the agent sends this session's own list.
        availableCommands: this.pool.lastCommands(agentId),
        busy: false,
        createdAt: Date.now(),
      };
      if (!modelOption(this.session.configOptions)) this.models.noteNoChoice(agentId);
      this.post({ type: "session", session: this.session });
      this.preferredApply = this.applyPreferredModel(token);
      return true;
    } catch (err) {
      // Stale generations must not change the new connection's status.
      if (token !== this.connectToken) return false;
      if (isAuthRequired(err)) {
        this.setConnection("auth_required", "The agent requires authentication");
        this.models.setStatus(agentId, "auth_required");
      } else {
        this.toast("error", `Could not create session: ${err instanceof Error ? err.message : err}`);
        this.models.setStatus(agentId, "error", err instanceof Error ? err.message : String(err));
      }
      return false;
    }
  }

  /** Explicit new chat — the only path that clears the thread/draft context. */
  async newSession(): Promise<void> {
    const previousTurn = this.runningTurn;
    if (!(await this.yieldForeground())) return;
    const token = ++this.connectToken;
    if (!this.activeAgentId) {
      this.toast("warning", "Select an agent first.");
      return;
    }
    const connected = this.connection.connected || await this.spawn(this.activeAgentId, token);
    if (!connected || !(await this.createSession(token))) {
      if (token === this.connectToken && previousTurn) {
        if (this.background.get(previousTurn.session.sessionId) === previousTurn) {
          await this.bringToForeground(previousTurn);
        } else {
          await this.openThread(previousTurn.owner.threadId);
        }
      }
      return;
    }
    this.activeThreadId = undefined;
    this.pendingAgentId = undefined;
    this.model.reset();
    this.post({ type: "entriesReplace", sessionId: this.session!.sessionId, entries: [] });
    this.postSnapshot();
  }

  async listNativeSessions(all = false): Promise<void> {
    if (!this.activeAgentId || !this.connection.connected) return;
    const agentId = this.activeAgentId;
    const token = this.connectToken;
    try {
      const list: SessionSummary[] = [];
      let cursor: string | null | undefined = undefined;
      do {
        const res: acp.ListSessionsResponse = await this.connection.request(
          acp.methods.agent.session.list,
          {
            ...(all ? {} : { cwd: workspaceCwd() }),
            cursor: cursor ?? undefined,
          },
        );
        for (const s of res.sessions) {
          list.push({
            sessionId: s.sessionId,
            title: s.title,
            cwd: s.cwd,
            updatedAt: s.updatedAt,
          });
        }
        cursor = res.nextCursor;
        if (token !== this.connectToken) return;
      } while (cursor);
      this.nativeSessionsByAgent.set(agentId, list);
      this.post({ type: "nativeSessions", agentId, sessions: list });
    } catch (err) {
      console.warn("[acp] session/list failed", err);
    }
  }

  async loadSession(sessionId: string): Promise<void> {
    if (!(await this.yieldForeground())) return;
    if (!this.connection.connected) return;
    // Loading replaces the open context — retire any in-flight generation.
    const token = ++this.connectToken;
    this.model.reset();
    // The agent replays history through session/update notifications before
    // the response resolves — install a provisional meta so they land.
    this.session = {
      sessionId,
      agentId: this.activeAgentId!,
      cwd: workspaceCwd(),
      busy: false,
      createdAt: Date.now(),
      restored: true,
    };
    this.post({ type: "session", session: this.session });
    this.post({ type: "entriesReplace", sessionId, entries: [] });
    try {
      const res = await this.connection.request(
        acp.methods.agent.session.load,
        {
          sessionId,
          cwd: workspaceCwd(),
          additionalDirectories: workspaceRoots().slice(1),
          mcpServers: this.mcpServers(),
        },
        { cancellationSignal: AbortSignal.timeout(30_000) },
      );
      if (!this.session || token !== this.connectToken) return;
      this.pool.markAttached(this.session.agentId, sessionId);
      this.session = {
        ...this.session,
        modes: res.modes ?? null,
        configOptions: toConfigOptionInfos(res.configOptions ?? []),
      };
      this.model.endTurn();
      this.post({ type: "session", session: this.session });
      this.post({
        type: "entriesReplace",
        sessionId,
        entries: [...this.model.entries],
      });
      this.postSnapshot();
    } catch (err) {
      if (token !== this.connectToken) return;
      if (isAuthRequired(err)) {
        this.setConnection("auth_required");
      } else {
        this.toast("error", `Could not load session: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.activeAgentId || !this.connection.connected) return;
    const agentId = this.activeAgentId;
    const token = this.connectToken;
    try {
      await this.connection.request(acp.methods.agent.session.delete, { sessionId });
      this.pool.detach(agentId, sessionId);
      const sessions = (this.nativeSessionsByAgent.get(agentId) ?? []).filter(
        (s) => s.sessionId !== sessionId,
      );
      this.nativeSessionsByAgent.set(agentId, sessions);
      if (token === this.connectToken) this.post({ type: "nativeSessions", agentId, sessions });
    } catch (err) {
      this.toast("error", `Could not delete session: ${err instanceof Error ? err.message : err}`);
    }
  }

  async closeSession(): Promise<void> {
    if (!this.session || !this.connection.connected) return;
    this.pool.detach(this.session.agentId, this.session.sessionId);
    try {
      await this.connection.request(acp.methods.agent.session.close, {
        sessionId: this.session.sessionId,
      });
    } catch {
      /* agent may not support close */
    }
  }

  /* ================= threads ================= */

  /** Render a stored thread and re-attach its most recent backing session. */
  async openThread(threadId: string): Promise<void> {
    if (threadId === this.activeThreadId && this.promptInFlight) return;
    const meta = this.threadStore.get(threadId);
    if (!meta) return;
    if (!(await this.yieldForeground())) return;
    const running = [...this.background.values()].find((t) => t.owner.threadId === threadId);
    if (running) {
      await this.bringToForeground(running);
      return;
    }
    this.clearActivity(threadId);
    const token = ++this.connectToken;
    const stored = await this.threadStore.entriesOf(threadId);
    // A newer selection/load during the read wins — never mutate the model
    // for a stale open.
    if (token !== this.connectToken) return;
    this.activeThreadId = threadId;
    this.pendingAgentId = undefined;
    this.model.reset();
    this.model.entries = [...stored];
    this.session = null;

    const backings = [...meta.backing].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    const target =
      backings.find((b) => b.agentId === this.activeAgentId) ?? backings[0];
    this.post({ type: "entriesReplace", sessionId: "", entries: [...this.model.entries] });
    if (!target) {
      this.post({ type: "session", session: null });
      this.postSnapshot();
      return;
    }
    target.lastUsedAt = Date.now();
    this.threadStore.updateMeta(meta.id, { backing: meta.backing });

    if (
      target.agentId !== this.activeAgentId ||
      !this.connection.connected
    ) {
      if (!(await this.spawn(target.agentId, token))) {
        this.post({ type: "session", session: null });
        this.postSnapshot();
        return;
      }
    }
    if (token !== this.connectToken) return;
    await this.attachThreadSession(meta, target, token);
    this.postSnapshot();
  }

  /** resume > load (replay suppressed: the stored transcript is ours).
   *  Resolves null when the agent offers neither; throws on RPC failure. */
  private async reattachRpc(sessionId: string): Promise<{
    modes?: SessionMeta["modes"];
    configOptions?: acp.SessionConfigOption[] | null;
  } | null> {
    const caps = this.connection.initResponse?.agentCapabilities;
    if (!caps) {
      // initResponse was cleared between the connected check and here — a
      // respawn raced this attach. Fail loudly so the caller's
      // fresh-session fallback is deliberate.
      throw new Error("agent connection not initialized");
    }
    const params = {
      sessionId,
      cwd: workspaceCwd(),
      additionalDirectories: workspaceRoots().slice(1),
      mcpServers: this.mcpServers(),
    };
    const reqOpts = { cancellationSignal: AbortSignal.timeout(30_000) };
    if (caps.sessionCapabilities?.resume) {
      return (await this.connection.request(
        acp.methods.agent.session.resume,
        params,
        reqOpts,
      )) as { modes?: SessionMeta["modes"]; configOptions?: acp.SessionConfigOption[] };
    }
    if (caps.loadSession) {
      this.suppressReplay.add(sessionId);
      try {
        return await this.connection.request(acp.methods.agent.session.load, params, reqOpts);
      } finally {
        this.suppressReplay.delete(sessionId);
      }
    }
    return null;
  }

  /** Re-attach `backing` for an open thread: already live > resume > load
   *  (replay off) > lazy new. Returns true only when a session handle exists. */
  private async attachThreadSession(
    meta: ThreadMeta,
    backing: { agentId: string; sessionId: string },
    token = this.connectToken,
  ): Promise<boolean> {
    // Never issue requests for a stale generation.
    if (token !== this.connectToken) return false;
    const live = this.pool.attached(backing.agentId, backing.sessionId);
    if (live) {
      logTiming(`open ${backing.agentId}: session already live, no agent call`);
      this.session = { ...live, busy: false, restored: true };
      this.post({ type: "session", session: this.session });
      return true;
    }
    const sw = new Stopwatch(`open ${backing.agentId}`);
    const base: SessionMeta = {
      sessionId: backing.sessionId,
      agentId: backing.agentId,
      cwd: workspaceCwd(),
      busy: false,
      createdAt: meta.createdAt,
      restored: true,
    };
    try {
      const res = await this.reattachRpc(backing.sessionId);
      if (token !== this.connectToken) return false;
      if (res) {
        sw.lap("resumed");
        this.pool.markAttached(backing.agentId, backing.sessionId);
        this.session = {
          ...base,
          modes: res.modes ?? null,
          configOptions: toConfigOptionInfos(res.configOptions ?? []),
        };
      } else {
        // No re-attach path — the next prompt lazily starts session/new.
        this.session = null;
      }
    } catch (err) {
      // Stale attach must not change the newer connection's status/session.
      if (token !== this.connectToken) return false;
      console.warn(
        `[acp] thread attach failed (${backing.agentId}/${backing.sessionId})`,
        err,
      );
      // A surviving session handle here is stale (e.g. the prompt hit an
      // auth wall on it) — drop it so resolution never reads truthiness as
      // "ready". Auth keeps the thread pending sign-in; other failures fall
      // through to a fresh session.
      this.session = null;
      if (isAuthRequired(err)) {
        this.setConnection("auth_required");
      } else {
        this.toast(
          "warning",
          `Couldn't resume the previous session — the agent will start fresh.`,
        );
      }
    }
    this.post({ type: "session", session: this.session });
    return this.session !== null;
  }

  async deleteThread(threadId: string): Promise<void> {
    const busy =
      (this.promptInFlight && threadId === this.activeThreadId) ||
      [...this.background.values()].some((t) => t.owner.threadId === threadId);
    if (busy) {
      this.toast("info", "Stop the agent working in this thread first.");
      return;
    }
    const meta = this.threadStore.get(threadId);
    if (!meta) return;
    const remote = meta.backing.find((b) => b.agentId === this.activeAgentId);
    const canRemote =
      !!remote &&
      this.connection.connected &&
      !!this.connection.initResponse?.agentCapabilities?.sessionCapabilities
        ?.delete;
    const choice = await vscode.window.showWarningMessage(
      `Delete "${meta.title}"?`,
      { modal: true },
      "Delete",
      ...(canRemote ? (["Delete everywhere"] as const) : []),
    );
    if (!choice) return;
    if (choice === "Delete everywhere" && remote) {
      try {
        await this.connection.request(acp.methods.agent.session.delete, {
          sessionId: remote.sessionId,
        });
        this.pool.detach(remote.agentId, remote.sessionId);
      } catch {
        /* local delete still proceeds */
      }
    }
    if (this.activeThreadId === threadId) {
      this.activeThreadId = undefined;
      this.model.reset();
      this.session = null;
      this.post({ type: "session", session: null });
      this.post({ type: "entriesReplace", sessionId: "", entries: [] });
    }
    await this.threadStore.delete(threadId);
    this.clearActivity(threadId);
    this.postSnapshot();
  }

  renameThread(threadId: string, title: string): void {
    const t = title.trim();
    if (!t) return;
    this.threadStore.updateMeta(threadId, { title: t, titleIsUser: true });
    this.postSnapshot();
  }

  setThreadPinned(threadId: string, pinned: boolean): void {
    this.threadStore.updateMeta(threadId, { pinned });
    this.postSnapshot();
  }

  setThreadArchived(threadId: string, archived: boolean): void {
    this.threadStore.updateMeta(threadId, { archived });
    this.postSnapshot();
  }

  async setThreadsScope(scope: "workspace" | "all"): Promise<void> {
    await vscode.workspace
      .getConfiguration("shipwreck")
      .update("threads.scope", scope, vscode.ConfigurationTarget.Global);
    this.postSnapshot();
  }

  /**
   * Import a native agent session into a thread and replay it into the
   * model via session/load — the one case where replay is the source of truth.
   */
  async importSession(
    agentId: string,
    sessionId: string,
    title?: string,
  ): Promise<void> {
    if (!(await this.yieldForeground())) return;
    const impId = `imp:${agentId}:${sessionId}`;
    if (this.threadStore.get(impId)) {
      await this.openThread(impId);
      return;
    }
    const token = ++this.connectToken;
    if (agentId !== this.activeAgentId || !this.connection.connected) {
      if (!(await this.spawn(agentId, token))) return;
    }
    if (token !== this.connectToken) return;
    const meta: ThreadMeta = {
      id: impId,
      title: title?.trim() || "Untitled chat",
      workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agents: [agentId],
      backing: [
        { agentId, sessionId, coveredEntries: 0, lastUsedAt: Date.now() },
      ],
      source: { kind: "acp-import", agentId, sessionId },
    };
    this.activeThreadId = meta.id;
    this.model.reset();
    this.session = {
      sessionId,
      agentId,
      cwd: workspaceCwd(),
      busy: false,
      createdAt: meta.createdAt,
      restored: true,
    };
    this.post({ type: "session", session: this.session });
    this.post({ type: "entriesReplace", sessionId, entries: [] });
    this.postSnapshot();
    try {
      const res = await this.connection.request(
        acp.methods.agent.session.load,
        {
          sessionId,
          cwd: workspaceCwd(),
          additionalDirectories: workspaceRoots().slice(1),
          mcpServers: this.mcpServers(),
        },
        { cancellationSignal: AbortSignal.timeout(30_000) },
      );
      if (token !== this.connectToken) return;
      this.pool.markAttached(agentId, sessionId);
      this.session = {
        ...this.session,
        modes: res.modes ?? null,
        configOptions: toConfigOptionInfos(res.configOptions ?? []),
      };
      this.model.endTurn();
      this.post({ type: "session", session: this.session });
      this.post({
        type: "entriesReplace",
        sessionId,
        entries: [...this.model.entries],
      });
      const backing = meta.backing[0];
      backing.coveredEntries = this.model.entries.length;
      this.threadStore.put({ ...meta }, [...this.model.entries]);
      await this.threadStore.flush();
      this.postSnapshot();
      void this.listNativeSessions();
    } catch (err) {
      if (token !== this.connectToken) return;
      if (isAuthRequired(err)) {
        this.setConnection("auth_required");
      } else {
        this.toast(
          "error",
          `Could not import session: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /** Create/patch the app thread that this session backs. */
  private ensureThread(firstPrompt?: string): void {
    if (!this.session || !this.activeAgentId) return;
    const { agentId, sessionId } = this.session;
    let meta = this.activeThreadId
      ? this.threadStore.get(this.activeThreadId)
      : undefined;
    if (!meta) {
      meta = {
        id: crypto.randomUUID(),
        title: firstPrompt?.trim().slice(0, 60) || "Untitled chat",
        workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        agents: [agentId],
        backing: [],
      };
      this.activeThreadId = meta.id;
    }
    let backing = meta.backing.find(
      (b) => b.agentId === agentId && b.sessionId === sessionId,
    );
    if (!backing) {
      // A fresh session supersedes this agent's older backing records (e.g.
      // resume failed and session/new minted a replacement) — drop them so
      // resolution can't pick a dead session back up.
      meta.backing = meta.backing.filter(
        (b) => !(b.agentId === agentId && b.sessionId !== sessionId),
      );
      backing = {
        agentId,
        sessionId,
        coveredEntries: 0,
        lastUsedAt: Date.now(),
      };
      meta.backing.push(backing);
      if (!meta.agents.includes(agentId)) meta.agents.push(agentId);
    }
    this.threadStore.put({ ...meta }, [...this.model.entries]);
    this.postSnapshot();
  }

  /**
   * Make sure the thread's backing for the active agent is attached:
   * resume/load when possible, else a fresh session/new (Phase-2 handoff).
   * Returns true only when a live session handle exists afterwards —
   * auth_required and stale generations return false.
   */
  private async resolveThreadSession(
    meta: ThreadMeta,
    token = this.connectToken,
  ): Promise<boolean> {
    if (token !== this.connectToken) return false;
    // Prefer the live session, else the most recently used backing for this
    // agent — a failed-resume fallback can leave several backings behind.
    const candidates = meta.backing.filter(
      (b) => b.agentId === this.activeAgentId,
    );
    const backing =
      candidates.find((b) => b.sessionId === this.session?.sessionId) ??
      [...candidates].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    if (backing) {
      if (
        this.session?.sessionId === backing.sessionId &&
        this.session.agentId === this.activeAgentId &&
        this.connection.connected &&
        this.connectionStatus === "connected"
      ) {
        return true;
      }
      if (!this.connection.connected && this.activeAgentId) {
        if (!(await this.spawn(this.activeAgentId, token))) return false;
      }
      if (token !== this.connectToken) return false;
      // Drop any stale handle before re-attaching — a leftover session from a
      // failed turn must not read as "ready" if attach hits auth again.
      this.session = null;
      if (!(await this.attachThreadSession(meta, backing, token))) {
        if (token !== this.connectToken) return false;
        if (this.session) return true;
        // Auth during attach must not silently mint a fresh session.
        if (this.connectionStatus === "auth_required") return false;
        // Other attach failures/unsupported fall through to session/new.
      } else {
        if (token !== this.connectToken) return false;
        return true;
      }
    }
    if (!this.connection.connected) {
      if (!this.activeAgentId || !(await this.spawn(this.activeAgentId, token)))
        return false;
    }
    if (token !== this.connectToken) return false;
    if (await this.createSession(token)) {
      // Register the fresh backing now — otherwise the next resolution
      // re-probes the dead session and mints another replacement.
      this.ensureThread();
      return true;
    }
    return false;
  }

  private agentName(id: string): string {
    return this.installer.descriptors().find((a) => a.id === id)?.name ?? id;
  }

  /** Persist the active thread's transcript + meta. `advanceCoverage` marks
   *  the current backing as having seen every entry — only a completed
   *  prompt may claim that, so failed sends keep their delta for retry. */
  private persistThread(advanceCoverage: boolean): void {
    if (this.activeThreadId) {
      this.persistRun(this.activeThreadId, this.model, this.session, advanceCoverage);
    }
  }

  private persistRun(
    id: string,
    model: SessionModel,
    session: SessionMeta | null,
    advanceCoverage: boolean,
  ): void {
    const meta = this.threadStore.get(id);
    if (!meta) return;
    const lastAgent = [...model.entries]
      .reverse()
      .find((e) => e.kind === "agent");
    const preview = lastAgent?.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join(" ")
      .trim()
      .slice(0, 120);
    for (const b of meta.backing) {
      if (session && b.agentId === session.agentId && b.sessionId === session.sessionId) {
        if (advanceCoverage) b.coveredEntries = model.entries.length;
        b.lastUsedAt = Date.now();
      }
    }
    meta.updatedAt = Date.now();
    if (preview) meta.preview = preview;
    this.threadStore.put({ ...meta }, [...model.entries]);
  }

  /** Synchronous admission lock: one on-screen prompt (incl. preflight) at a time. */
  private turnLock: object | undefined;
  private get promptInFlight(): boolean {
    return this.turnLock !== undefined;
  }
  /** Auth dedup is per-generation: a hung sign-in for agent B must not
   *  block agent C's. */
  private authInFlight: { token: number; promise: Promise<void> } | undefined;
  /** The turn allowed to advance coveredEntries once it completes —
   *  {generation, agent, session, thread}. Streaming never advances it. */
  private turnCoverage: TurnOwner | undefined;
  /** Deferred agent restart while a turn holds the admission lock. */
  private pendingRestart: (() => void) | undefined;

  async sendPrompt(
    text: string,
    attachments: Attachment[] = [],
    requestId?: string,
  ): Promise<void> {
    const editorContext = this.editorContext.capture();
    attachments = attachments.map((attachment) => this.editorContext.enrich(attachment));
    const active = editorContext.attachment;
    if (active && !attachments.some((a) => a.uri === active.uri
      && a.range?.startLine === active.range?.startLine && a.range?.endLine === active.range?.endLine)) {
      attachments = [...attachments, active];
    }
    // Exactly one outcome per requestId — settled guards double-posts from
    // both early-return paths and the outer catch.
    let settled = false;
    const accept = () => {
      if (settled) return;
      settled = true;
      editorContext.accepted();
      if (requestId) this.post({ type: "promptAccepted", requestId });
    };
    const reject = (reason: string) => {
      if (settled) return;
      settled = true;
      if (requestId) this.post({ type: "promptRejected", requestId, reason });
    };
    // The lock must be taken before any await so a second send can't slip in.
    if (this.promptInFlight) {
      reject("A prompt is already in progress.");
      return;
    }
    const lock = {};
    this.turnLock = lock;
    try {
      const token = this.connectToken;
      const meta0 = this.activeThreadId
        ? this.threadStore.get(this.activeThreadId)
        : undefined;
      if (this.activeThreadId && !meta0) this.activeThreadId = undefined;
      if (meta0) {
        // Resolve the right backing for the active agent (attach / lazy new).
        await this.resolveThreadSession(meta0, token);
      }
      if (token !== this.connectToken) {
        reject("The context changed while sending.");
        return;
      }
      if (!this.connection.connected || !this.session) {
        if (!this.activeThreadId) {
          if (!this.connection.connected) {
            if (!this.activeAgentId) {
              reject("Select an agent first.");
              return;
            }
            if (!(await this.spawn(this.activeAgentId, token))) {
              reject("Could not start the agent.");
              return;
            }
          }
          if (token !== this.connectToken) {
            reject("The context changed while sending.");
            return;
          }
          if (!this.session && !(await this.createSession(token))) {
            reject("Could not start a session.");
            return;
          }
        } else {
          reject("Could not reach the agent for this thread.");
          return;
        }
        if (!this.session) {
          reject("No session is ready.");
          return;
        }
      }
      if (this.connectionStatus === "auth_required") {
        reject("The agent requires sign-in first.");
        return;
      }
      await this.sendPromptInner(text, attachments, token, accept, reject);
    } catch (err) {
      // Any unexpected preflight exception still settles the ack once —
      // never after an accept.
      reject(err instanceof Error ? err.message : "Could not send the prompt.");
    } finally {
      // A turn sent to the background already gave the lock up.
      if (this.turnLock === lock) {
        this.turnLock = undefined;
        // A transport death during the turn queued a restart — run it now
        // that the lock is released (same target, same thread, no replay).
        const restart = this.pendingRestart;
        this.pendingRestart = undefined;
        restart?.();
      }
    }
  }

  private async sendPromptInner(
    text: string,
    attachments: Attachment[],
    token: number,
    accept: () => void,
    reject: (reason: string) => void,
  ): Promise<void> {
    const session = this.session;
    if (!session) {
      reject("No session is ready.");
      return;
    }
    const capabilities = this.connection.initResponse?.agentCapabilities?.promptCapabilities ?? {};
    const { blocks, parts, warnings } = await buildPrompt(
      text, attachments, capabilities, (att) => this.readAttachmentText(att),
    );
    if (!blocks.length) {
      reject(warnings[0] ?? "Nothing to send.");
      return;
    }
    for (const warning of warnings) this.toast("warning", warning);
    if (token !== this.connectToken) {
      reject("The context changed while sending.");
      return;
    }

    const filePart = parts.find((p) => p.type === "resource_link" || p.type === "resource");
    const fileName = filePart && path.basename(vscode.Uri.parse(filePart.uri).fsPath);
    this.pendingAgentId = undefined;
    this.ensureThread(text.trim() || fileName);
    // This turn owns coverage advancement for its session+thread.
    const owner: TurnOwner = {
      token,
      agentId: session.agentId,
      sessionId: session.sessionId,
      threadId: this.activeThreadId!,
      complete: false,
    };
    this.turnCoverage = owner;
    // Entries appended below (handoff marker + user message) roll back to
    // this point if persisting them fails.
    const baseEntries = this.model.entries.length;
    const rollback = () => {
      if (
        token !== this.connectToken ||
        this.session !== session ||
        this.activeThreadId !== owner.threadId
      ) return;
      this.model.entries.length = baseEntries;
      this.threadStore.setEntries(owner.threadId, [...this.model.entries]);
      this.post({
        type: "entriesReplace",
        sessionId: session.sessionId,
        entries: [...this.model.entries],
      });
    };

    // Context handoff: prepend a budgeted summary + transcript link when the
    // backing hasn't seen all of this thread's entries.
    const meta = this.activeThreadId
      ? this.threadStore.get(this.activeThreadId)
      : undefined;
    const backing = meta?.backing.find(
      (b) => b.agentId === session.agentId && b.sessionId === session.sessionId,
    );
    const carryContext = vscode.workspace
      .getConfiguration("shipwreck")
      .get<boolean>("threads.carryContext", true);
    if (meta && backing && carryContext) {
      const delta = this.model.entries.slice(backing.coveredEntries);
      const handoff = buildHandoff(delta, {
        budgetBytes: HANDOFF_BUDGET_BYTES,
        agentName: (id) => this.agentName(id),
        currentAgentId: session.agentId,
      });
      if (handoff) {
        // Full transcript on disk; the agent gets it as a resource link.
        const transcriptPath = path.join(
          this.threadStore.root(),
          "threads",
          meta.id,
          "transcript.md",
        );
        const transcript = buildTranscript(this.model.entries, (id) =>
          this.agentName(id),
        );
        // If the transcript can't be persisted the prompt must not carry a
        // link to a file that doesn't exist — reject pre-accept, draft kept.
        try {
          await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });
          await fsp.writeFile(transcriptPath, transcript);
        } catch (err) {
          console.warn("[acp] transcript write failed", err);
          reject("Could not save the thread transcript — try again.");
          return;
        }
        // Ownership re-check after the awaited transcript write — a context
        // switch during IO must not append entries to the wrong model.
        if (
          token !== this.connectToken ||
          this.session !== session ||
          this.activeThreadId !== owner.threadId
        ) {
          reject("The context changed while sending.");
          return;
        }
        const handoffEntry: ChatEntry = {
          id: `handoff-${Date.now()}`,
          kind: "handoff",
          ts: Date.now(),
          toAgentId: session.agentId,
          fromAgents: handoff.agents,
          included: handoff.included,
          omitted: handoff.omitted,
          text: handoff.text,
        };
        this.model.insertEntry(handoffEntry);
        this.postClosed(session.sessionId);
        this.post({ type: "entryUpsert", sessionId: session.sessionId, entry: handoffEntry });
        blocks.unshift(
          {
            type: "resource_link",
            uri: vscode.Uri.file(transcriptPath).toString(),
            name: "Thread transcript",
            mimeType: "text/markdown",
          },
          { type: "text", text: handoff.text },
        );
      }
    }

    this.model.addLocalUserMessage(parts);
    this.postClosed(session.sessionId);
    this.post({
      type: "entryUpsert",
      sessionId: session.sessionId,
      entry: this.model.entries[this.model.entries.length - 1],
    });

    // Persist the transcript before accepting — if disk fails the draft
    // stays and the appended entries roll back for this context.
    try {
      this.persistThread(false);
      await this.threadStore.flush();
    } catch (err) {
      rollback();
      console.warn("[acp] prompt persist failed", err);
      reject("Could not save the message — try again.");
      return;
    }

    // Final ownership check after the awaited flush: a context switch or
    // transport death during persistence must not accept on a dead conn.
    if (
      token !== this.connectToken ||
      this.session !== session ||
      this.activeThreadId !== owner.threadId ||
      !this.connection.connected ||
      this.initializedAgentId !== session.agentId
    ) {
      rollback();
      reject("The context changed while sending.");
      return;
    }
    accept();
    const turn: RunningTurn = { lock: this.turnLock!, session, model: this.model, owner };
    this.runningTurn = turn;
    this.changes.begin(session.sessionId);
    this.setBusy(true);
    this.promptTiming = {
      sessionId: session.sessionId,
      sw: new Stopwatch(`prompt ${session.agentId}`),
      seen: false,
    };
    let promptOk = false;
    // The turn stays on this agent's process even if it moves to the background.
    const conn = this.connection;
    try {
      const prompt = () =>
        conn.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: blocks,
        });
      const res = await prompt().catch(async (err: unknown) => {
        // The agent dropped the session (e.g. evicted it): re-attach the same
        // id once and resend. Only a rejection before the prompt was inserted
        // gets here, so nothing repeats.
        if (
          isSessionNotFound(err) &&
          !(err instanceof InsertedPromptFailed) &&
          (await this.reattachForRetry(session, owner.token))
        ) {
          return prompt();
        }
        throw err;
      });
      promptOk = true;
      if (this.background.get(session.sessionId) === turn) {
        this.finishBackgroundTurn(turn, res.stopReason);
        return;
      }
      // A completed turn may advance coverage — including entries that
      // arrive slightly late for the same owner.
      if (this.turnCoverage === owner) owner.complete = true;
      const notice = stopReasonNotice(res.stopReason);
      if (notice) this.pushMarker(notice, "notice");
    } catch (err) {
      if (this.background.get(session.sessionId) === turn) {
        this.finishBackgroundTurn(turn, undefined, err);
        return;
      }
      if (owner.token !== this.connectToken || this.session !== session) return;
      if (isAuthRequired(err)) {
        this.setConnection("auth_required");
      } else {
        this.pushMarker(
          `Prompt failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    } finally {
      void this.recordChanges(turn);
      if (this.runningTurn === turn) this.runningTurn = undefined;
      // Only close the turn we own — a context switch may have replaced the
      // session and model while this request was in flight.
      if (this.session === session) {
        for (const e of this.model.endTurn()) {
          this.post({ type: "entryUpsert", sessionId: session.sessionId, entry: e });
        }
        this.setBusy(false);
      }
      if (this.promptTiming?.sessionId === session.sessionId) {
        this.promptTiming.sw.lap(promptOk ? "turn complete" : "turn failed");
        this.promptTiming = undefined;
      }
      // Coverage advances only on a completed prompt that still owns this
      // thread; a rejected/stale request keeps its delta for the next retry.
      if (
        this.turnCoverage === owner &&
        owner.token === this.connectToken &&
        this.session === session &&
        this.activeThreadId === owner.threadId
      ) {
        this.persistThread(promptOk);
      }
    }
  }

  /** Re-attach the live session after the agent reported it unknown.
   *  Keeps `session` (and the turn that owns it) intact. */
  private async reattachForRetry(session: SessionMeta, token: number): Promise<boolean> {
    if (token !== this.connectToken || this.session !== session) return false;
    this.pool.detach(session.agentId, session.sessionId);
    try {
      if (!(await this.reattachRpc(session.sessionId))) return false;
    } catch (err) {
      console.warn("[acp] re-attach after session-not-found failed", err);
      return false;
    }
    if (token !== this.connectToken || this.session !== session) return false;
    logTiming(`prompt ${session.agentId}: session was gone, re-attached and resent`);
    this.pool.markAttached(session.agentId, session.sessionId);
    this.pool.remember(session);
    return true;
  }

  /* ================= model picker ================= */

  private postModels(): void {
    this.post({ type: "agentModels", agentModels: this.models.list() });
  }

  /** Switch to the agent if needed, then select the model. The pick also
   *  becomes that agent's model for its next new chats. */
  async pickModel(agentId: string, value?: string): Promise<void> {
    if (value !== undefined) this.models.setPreferred(agentId, value);
    if (agentId !== this.activeAgentId || this.session?.agentId !== agentId) {
      await this.selectAgent(agentId);
      await this.preferredApply;
    }
    if (value === undefined) return;
    const session = this.session;
    // Not ready (sign-in, failed start): the preference applies to its next session.
    if (!session || session.agentId !== agentId) return;
    const opt = modelOption(session.configOptions);
    if (opt && String(opt.currentValue) !== value && opt.options?.some((o) => o.value === value)) {
      await this.setConfigOption(opt.id, value);
    }
  }

  private async applyPreferredModel(token: number): Promise<void> {
    const session = this.session;
    if (!session || token !== this.connectToken) return;
    const preferred = this.models.get(session.agentId)?.preferredValue;
    const opt = modelOption(session.configOptions);
    if (
      preferred !== undefined &&
      opt &&
      String(opt.currentValue) !== preferred &&
      opt.options?.some((o) => o.value === preferred)
    ) {
      await this.setConfigOption(opt.id, preferred);
    }
  }

  private probeQueue: string[] = [];
  private probeLanes = 0;

  /** Learn the models of installed agents whose list is missing or stale. */
  probeAgents(): void {
    for (const a of this.installer.descriptors()) {
      const id = a.id;
      if (
        !a.installed ||
        id === this.activeAgentId ||
        this.probes.has(id) ||
        this.probeQueue.includes(id) ||
        this.models.isFresh(id) ||
        this.hasBackgroundTurn(id)
      ) continue;
      this.probeQueue.push(id);
    }
    while (this.probeLanes < PROBE_CONCURRENCY && this.probeQueue.length) {
      this.probeLanes++;
      void this.drainProbes();
    }
  }

  private async drainProbes(): Promise<void> {
    for (let id = this.probeQueue.shift(); id; id = this.probeQueue.shift()) {
      await this.probeAgent(id);
    }
    this.probeLanes--;
  }

  private probeAgent(agentId: string): Promise<void> {
    const run = this.probeAgentInner(agentId).finally(() => this.probes.delete(agentId));
    this.probes.set(agentId, run);
    return run;
  }

  private async probeAgentInner(agentId: string): Promise<void> {
    const installed = () => this.installer.descriptors().some((a) => a.id === agentId && a.installed);
    // The active agent's own session keeps its list current.
    if (agentId === this.activeAgentId || !installed()) return;
    this.models.setStatus(agentId, "probing");
    const conn = this.pool.connection(agentId);
    let started = false;
    const sw = new Stopwatch(`probe ${agentId}`);
    try {
      if (!conn.connected) {
        const spec = await this.installer.launchSpec(agentId);
        if (agentId === this.activeAgentId || !installed()) return;
        const start = this.pool.start(agentId, spec, workspaceCwd(), "background");
        this.probeStarts.set(agentId, start);
        try {
          await start;
        } finally {
          this.probeStarts.delete(agentId);
        }
        started = true;
        sw.lap("initialize");
      }
      if (!installed()) {
        await conn.stop();
        return;
      }
      const res = await conn.request(
        acp.methods.agent.session.new,
        {
          cwd: workspaceCwd(),
          additionalDirectories: workspaceRoots().slice(1),
          mcpServers: this.mcpServers(),
        },
        { cancellationSignal: AbortSignal.timeout(30_000) },
      );
      if (!installed()) {
        await conn.stop();
        return;
      }
      sw.lap("models");
      this.pool.markAttached(agentId, res.sessionId);
      const spare: SessionMeta = {
        sessionId: res.sessionId,
        agentId,
        cwd: workspaceCwd(),
        modes: res.modes ?? null,
        configOptions: toConfigOptionInfos(res.configOptions ?? []),
        availableCommands: this.pool.lastCommands(agentId),
        busy: false,
        createdAt: Date.now(),
      };
      if (modelOption(spare.configOptions)) this.models.noteOptions(agentId, spare.configOptions);
      else this.models.noteNoChoice(agentId);
      if (agentId === this.activeAgentId || this.pool.withinLimit()) {
        this.spares.set(agentId, spare);
      } else if (started) {
        this.pool.stop(agentId);
      }
    } catch (err) {
      if (!installed()) return;
      if (isAuthRequired(err)) {
        this.models.setStatus(agentId, "auth_required");
        return;
      }
      this.models.setStatus(agentId, "error", err instanceof Error ? err.message : String(err));
      if (started) this.pool.stop(agentId);
    }
  }

  /** The probe's session for this agent, if its process still holds it. Used once. */
  private takeSpare(agentId: string): SessionMeta | undefined {
    const spare = this.spares.get(agentId);
    if (!spare) return undefined;
    this.spares.delete(agentId);
    return this.pool.holds(agentId, spare.sessionId) ? spare : undefined;
  }

  /** Commands and options a spare session announces before anyone uses it. */
  private onSpareUpdate(agentId: string, n: acp.SessionNotification): void {
    const spare = this.spares.get(agentId);
    if (spare?.sessionId !== n.sessionId) return;
    new SessionModel().applyUpdate(n, spare);
    this.pool.remember(spare);
    if (n.update.sessionUpdate === "config_option_update") {
      this.models.noteOptions(agentId, spare.configOptions);
    }
  }

  /* ================= background turns ================= */
  private switchWhileRunning(): SwitchWhileRunning {
    return vscode.workspace
      .getConfiguration("shipwreck")
      .get<SwitchWhileRunning>("switchWhileRunning", "keepRunning");
  }

  /** Make way for a context switch. A running turn moves to the background
   *  and keeps working in its thread. False means the switch must not happen. */
  private async yieldForeground(): Promise<boolean> {
    if (!this.promptInFlight) return true;
    if (!this.runningTurn || this.runningTurn.lock !== this.turnLock) {
      this.toast("info", "The message is still being sent — try again in a moment.");
      return false;
    }
    if (this.switchWhileRunning() === "ask") {
      const pick = await vscode.window.showWarningMessage(
        `${this.agentName(this.runningTurn.session.agentId)} is still working on this thread.`,
        { modal: true, detail: "It can keep running in the background while you switch." },
        "Keep running",
        "Stop",
      );
      if (!pick) return false;
      if (pick === "Stop") this.cancelTurn();
    }
    // The turn may have ended while the dialog was open.
    if (!this.promptInFlight) return true;
    return this.sendTurnToBackground();
  }

  private sendTurnToBackground(): boolean {
    const turn = this.runningTurn;
    if (!turn || turn.lock !== this.turnLock || this.session !== turn.session) return false;
    this.runningTurn = undefined;
    this.background.set(turn.session.sessionId, turn);
    this.persistRun(turn.owner.threadId, turn.model, turn.session, false);
    this.setActivity(
      turn.owner.threadId,
      turn.session.agentId,
      this.hasPendingInput(turn) ? "needs_input" : "running",
    );
    logTiming(`turn ${turn.session.agentId}: continues in the background`);
    this.turnLock = undefined;
    this.pendingRestart = undefined;
    this.promptTiming = undefined;
    this.turnCoverage = undefined;
    this.model = new SessionModel();
    this.session = null;
    this.activeThreadId = undefined;
    this.pendingAgentId = undefined;
    this.post({ type: "session", session: null });
    this.post({ type: "entriesReplace", sessionId: "", entries: [] });
    return true;
  }

  /** Reopen a thread whose turn is still running: it becomes the on-screen turn again. */
  private async bringToForeground(turn: RunningTurn): Promise<void> {
    const token = ++this.connectToken;
    this.background.delete(turn.session.sessionId);
    this.clearActivity(turn.owner.threadId);
    turn.owner.token = token;
    this.model = turn.model;
    this.session = turn.session;
    this.activeThreadId = turn.owner.threadId;
    this.pendingAgentId = undefined;
    this.turnCoverage = turn.owner;
    this.turnLock = turn.lock;
    this.runningTurn = turn;
    this.post({ type: "session", session: this.session });
    this.post({
      type: "entriesReplace",
      sessionId: turn.session.sessionId,
      entries: [...this.model.entries],
    });
    if (turn.session.agentId !== this.activeAgentId || !this.connection.connected) {
      await this.spawn(turn.session.agentId, token);
    }
    if (token === this.connectToken) this.postSnapshot();
  }

  private finishBackgroundTurn(turn: RunningTurn, stopReason?: string, err?: unknown): void {
    const { model, session, owner } = turn;
    this.background.delete(session.sessionId);
    session.busy = false;
    model.endTurn();
    const failed = stopReason === undefined;
    if (failed) {
      model.insertEntry({
        id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: "notice",
        ts: Date.now(),
        severity: "error",
        title: isAuthRequired(err)
          ? "The agent requires sign-in."
          : `Prompt failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } else {
      owner.complete = true;
      const notice = stopReasonNotice(stopReason);
      if (notice) {
        model.insertEntry({
          id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: "notice",
          ts: Date.now(),
          severity: "warning",
          title: notice,
        });
      }
    }
    this.persistRun(owner.threadId, model, session, !failed);
    this.pool.remember(session);
    if (stopReason === "cancelled") this.clearActivity(owner.threadId);
    else this.setActivity(owner.threadId, session.agentId, failed ? "failed" : "done");
    logTiming(`turn ${session.agentId}: background turn ${failed ? "failed" : "complete"}`);
  }

  private hasBackgroundTurn(agentId: string): boolean {
    for (const t of this.background.values()) if (t.session.agentId === agentId) return true;
    return false;
  }

  /** The background turn whose transcript holds this entry, if any. */
  private backgroundTurnOf(entryId: string): RunningTurn | undefined {
    for (const t of this.background.values()) {
      if (t.model.entries.some((e) => e.id === entryId)) return t;
    }
    return undefined;
  }

  private hasPendingInput(turn: RunningTurn): boolean {
    const ids = new Set([...this.pendingPermissions.keys(), ...this.pendingElicitations.keys()]);
    return ids.size > 0 && turn.model.entries.some((e) => ids.has(e.id));
  }

  /** A background turn asked for approval or input. */
  private backgroundNeedsInput(turn: RunningTurn): void {
    const threadId = turn.owner.threadId;
    this.setActivity(threadId, turn.session.agentId, "needs_input");
    this.persistRun(threadId, turn.model, turn.session, false);
    const title = this.threadStore.get(threadId)?.title ?? "a background thread";
    void vscode.window
      .showInformationMessage(
        `${this.agentName(turn.session.agentId)} needs your input in "${title}".`,
        "Open",
      )
      .then(async (pick) => {
        if (pick !== "Open") return;
        await this.focusChat();
        await this.openThread(threadId);
      });
  }

  private backgroundInputSettled(turn: RunningTurn | undefined): void {
    if (!turn || this.background.get(turn.session.sessionId) !== turn) return;
    this.persistRun(turn.owner.threadId, turn.model, turn.session, false);
    if (!this.hasPendingInput(turn)) {
      this.setActivity(turn.owner.threadId, turn.session.agentId, "running");
    }
  }

  private setActivity(threadId: string, agentId: string, state: ThreadActivity["state"]): void {
    this.activity.set(threadId, { threadId, agentId, state, updatedAt: Date.now() });
    this.postActivity();
  }

  private clearActivity(threadId: string): void {
    if (this.activity.delete(threadId)) this.postActivity();
  }

  private postActivity(): void {
    this.post({ type: "threadActivity", activity: [...this.activity.values()] });
    this.onDidUpdateEmitter.fire();
  }

  private applyBackgroundUpdate(turn: RunningTurn, notification: acp.SessionNotification): void {
    const { changed } = turn.model.applyUpdate(notification, turn.session);
    for (const entry of changed) {
      stampAgent(entry, turn.session.agentId);
      this.hydrateTerminals(entry, turn.owner.threadId);
    }
    const threadId = turn.owner.threadId;
    if (notification.update.sessionUpdate === "session_info_update") {
      const title = (notification.update as { title?: string }).title?.trim();
      const meta = this.threadStore.get(threadId);
      if (title && meta?.source?.kind === "acp-import" && !meta.titleIsUser && meta.title !== title) {
        this.threadStore.updateMeta(threadId, { title });
        this.postSnapshot();
      }
    }
    if (changed.length) this.threadStore.setEntries(threadId, [...turn.model.entries]);
  }
  private pushMarker(text: string, level: "notice" | "error" = "notice"): void {
    if (!this.session) return;
    const entry: ChatEntry = {
      id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "notice",
      ts: Date.now(),
      severity: level === "error" ? "error" : "warning",
      title: text,
    };
    this.model.insertEntry(entry);
    this.postClosed(this.session.sessionId);
    this.post({ type: "entryUpsert", sessionId: this.session.sessionId, entry });
  }

  /** Streams closed by a non-streamed insert — tell the webview to drop cursors. */
  private postClosed(sessionId: string): void {
    for (const e of this.model.drainClosed()) {
      this.post({ type: "entryUpsert", sessionId, entry: e });
    }
  }

  cancelTurn(): void {
    if (!this.session || !this.connection.connected) return;
    void this.connection.notify(acp.methods.agent.session.cancel, {
      sessionId: this.session.sessionId,
    });
    // The agent may be blocked on an approval; ACP requires answering it as cancelled.
    this.cancelPendingInput((turn) => !turn);
  }

  private setBusy(busy: boolean): void {
    if (!this.session) return;
    this.session.busy = busy;
    this.post({ type: "busy", sessionId: this.session.sessionId, busy });
    this.onDidUpdateEmitter.fire();
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.session || !this.connection.connected) return;
    const token = this.connectToken;
    try {
      await this.connection.request(acp.methods.agent.session.setMode, {
        sessionId: this.session.sessionId,
        modeId,
      });
      if (!this.session || token !== this.connectToken) return;
      if (this.session.modes) this.session.modes.currentModeId = modeId;
      this.post({ type: "session", session: this.session });
    } catch (err) {
      if (token !== this.connectToken) return;
      this.toast("error", `Could not set mode: ${err instanceof Error ? err.message : err}`);
    }
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    if (!this.session || !this.connection.connected) return;
    const token = this.connectToken;
    try {
      const res = await this.connection.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.session.sessionId,
        configId,
        ...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
      });
      const updated = (res as { configOptions?: acp.SessionConfigOption[] }).configOptions;
      if (!Array.isArray(updated)) {
        throw new Error("set_config_option returned no configOptions array");
      }
      if (!this.session || token !== this.connectToken) return;
      this.session.configOptions = toConfigOptionInfos(updated);
      this.post({ type: "session", session: this.session });
    } catch (err) {
      if (token !== this.connectToken) return;
      this.toast(
        "error",
        `Could not set option: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /* ================= auth ================= */

  /**
   * After a successful sign-in, restore the context that was interrupted:
   * an open thread re-attaches/creates its backing for the pending agent;
   * a draft just gets a session. Never clears the thread.
   */
  private async ensureActiveSession(token: number): Promise<void> {
    if (token !== this.connectToken || !this.connection.connected) return;
    if (this.activeAgentId) this.pool.forgetSessions(this.activeAgentId);
    const meta = this.activeThreadId
      ? this.threadStore.get(this.activeThreadId)
      : undefined;
    let ready = false;
    if (meta) {
      // Re-probe the backing — a session that failed auth earlier is not
      // trusted just because authenticate returned. resolveThreadSession
      // clears the stale handle before re-attaching.
      ready = await this.resolveThreadSession(meta, token);
      if (token !== this.connectToken) return;
    } else if (this.session) {
      // A draft session handle that survived an auth failure must be
      // revalidated before we claim ready — resume/load it, and if the
      // agent offers no re-attach path mint a fresh session (a draft has
      // no transcript to lose).
      const caps = this.connection.initResponse?.agentCapabilities;
      const canReattach =
        !!caps?.sessionCapabilities?.resume || !!caps?.loadSession;
      if (!canReattach) {
        this.session = null;
        ready = await this.createSession(token);
      } else {
        const stale = this.session;
        const stub: ThreadMeta = {
          id: "draft-revalidate",
          title: "",
          createdAt: stale.createdAt,
          updatedAt: stale.createdAt,
          agents: [stale.agentId],
          backing: [],
        };
        this.session = null;
        ready = await this.attachThreadSession(
          stub,
          { agentId: stale.agentId, sessionId: stale.sessionId },
          token,
        );
      }
      if (token !== this.connectToken) return;
      // A non-auth revalidation failure still leaves the draft usable —
      // mint a fresh session rather than reporting not-ready.
      if (!ready && this.connectionStatus !== "auth_required") {
        ready = await this.createSession(token);
      }
      if (token !== this.connectToken) return;
    } else {
      ready = await this.createSession(token);
      if (token !== this.connectToken) return;
    }
    // Connected only once a session is actually established — an auth
    // failure during revalidation leaves no session and stays auth_required.
    if (ready && this.session) {
      this.setConnection("connected");
    }
    if (token === this.connectToken) this.postSnapshot();
  }

  async authenticate(methodId?: string): Promise<void> {
    // Coalesce duplicate sign-in attempts for the same generation only —
    // a hung attempt for a retired selection must not block the new one.
    if (this.authInFlight?.token === this.connectToken) {
      return this.authInFlight.promise;
    }
    const token = this.connectToken;
    const promise = this.authenticateInner(methodId, token);
    this.authInFlight = { token, promise };
    try {
      await promise;
    } finally {
      if (this.authInFlight?.promise === promise) this.authInFlight = undefined;
    }
  }

  private async authenticateInner(methodId: string | undefined, token: number): Promise<void> {
    const agentId = this.activeAgentId;
    const methods = this.connection.initResponse?.authMethods ?? [];
    const method = methodId
      ? methods.find((m) => m.id === methodId)
      : methods[0];
    if (methodId && !method) {
      this.toast("warning", `Unknown sign-in method "${methodId}".`);
      return;
    }
    if (!method) {
      this.toast("info", "This agent does not advertise authentication methods.");
      return;
    }
    try {
      if ("type" in method && method.type === "terminal") {
        const spec = this.connection.spec;
        if (!spec) return;
        const termMethod = method as acp.AuthMethodTerminal & { type: "terminal" };
        // The terminal runs the agent's own command — merge the launch env
        // with the method's env (method wins on conflicts).
        const env = new Map<string, string>(
          Object.entries(spec.env ?? {}),
        );
        for (const [name, value] of Object.entries(termMethod.env ?? {})) {
          env.set(name, value);
        }
        let terminalId: string;
        try {
          const created = this.terminals.create({
            sessionId: "auth",
            command: spec.command,
            args: [...spec.args, ...(termMethod.args ?? [])],
            env: [...env].map(([name, value]) => ({ name, value })),
          });
          terminalId = created.terminalId;
        } catch (err) {
          if (token !== this.connectToken) return;
          this.toast(
            "error",
            `Could not start sign-in: ${err instanceof Error ? err.message : err}`,
          );
          return;
        }
        let status: Awaited<ReturnType<TerminalManager["waitForExit"]>>;
        try {
          status = await this.terminals.waitForExit(terminalId);
        } catch (err) {
          // A stale generation's sign-in failure must not reset the new
          // agent's state.
          if (token !== this.connectToken || agentId !== this.activeAgentId) {
            return;
          }
          this.setConnection(
            "auth_required",
            err instanceof Error ? err.message : "Sign-in failed",
          );
          this.toast(
            "error",
            `Authentication failed: ${err instanceof Error ? err.message : err}`,
          );
          return;
        }
        if (token !== this.connectToken || agentId !== this.activeAgentId) return;
        if (status.exitCode === 0) {
          await this.ensureActiveSession(token);
        } else {
          this.setConnection("auth_required", "Sign-in did not complete.");
          this.toast("error", "Authentication did not complete successfully.");
        }
        return;
      }

      try {
        await this.connection.request(acp.methods.agent.authenticate, {
          methodId: method.id,
        });
      } catch (err) {
        if (token !== this.connectToken) return;
        // Failed sign-in stays auth_required — retryable, nothing cleared.
        this.setConnection(
          "auth_required",
          err instanceof Error ? err.message : "Sign-in failed",
        );
        this.toast(
          "error",
          `Authentication failed: ${err instanceof Error ? err.message : err}`,
        );
        return;
      }
      // No "connected" until the session is actually re-established.
      if (token !== this.connectToken || agentId !== this.activeAgentId) return;
      await this.ensureActiveSession(token);
    } catch (err) {
      // Never leave an unhandled rejection or clobber a newer generation.
      if (token === this.connectToken) {
        console.warn("[acp] authenticate failed", err);
      }
    }
  }

  /* ================= client delegate ================= */

  onSessionUpdate(notification: acp.SessionNotification): void {
    // Replays from session/load for a re-attached thread are dropped — our
    // stored transcript is authoritative. (Imports are the one exception;
    // they don't suppress.)
    if (this.suppressReplay.has(notification.sessionId)) return;
    this.changes.noteUpdate(notification.sessionId, notification.update);
    const turn = this.background.get(notification.sessionId);
    if (turn) {
      this.applyBackgroundUpdate(turn, notification);
      return;
    }
    if (!this.session || notification.sessionId !== this.session.sessionId) return;
    const pt = this.promptTiming;
    if (pt && !pt.seen && pt.sessionId === notification.sessionId) {
      pt.seen = true;
      pt.sw.lap("first update");
    }
    const before = this.model.entries;
    const { changed, appended } = this.model.applyUpdate(notification, this.session);
    if (this.model.entries !== before) {
      this.post({
        type: "entriesReplace",
        sessionId: notification.sessionId,
        entries: [...this.model.entries],
      });
    }
    for (const entry of changed) {
      stampAgent(entry, this.session.agentId);
      this.hydrateTerminals(entry, this.activeThreadId);
      if (appended?.entryId === entry.id) {
        this.post({ type: "entryAppend", sessionId: notification.sessionId, ...appended });
      } else {
        this.post({ type: "entryUpsert", sessionId: notification.sessionId, entry });
      }
    }
    if (notification.update.sessionUpdate === "session_info_update") {
      const title = (notification.update as { title?: string }).title;
      const meta = this.activeThreadId
        ? this.threadStore.get(this.activeThreadId)
        : undefined;
      if (title?.trim() && meta?.source?.kind === "acp-import" && !meta.titleIsUser && meta.title !== title) {
        this.threadStore.updateMeta(meta.id, { title: title.trim() });
        this.postSnapshot();
      }
    }
    // Streaming updates persist the transcript but never advance coverage:
    // coveredEntries only moves once the owning turn's prompt completed
    // (late chunks for that same completed turn may still advance it).
    if (this.activeThreadId && changed.length) {
      this.threadStore.setEntries(this.activeThreadId, [...this.model.entries]);
      const cov = this.turnCoverage;
      if (
        cov?.complete &&
        cov.token === this.connectToken &&
        cov.sessionId === notification.sessionId &&
        cov.threadId === this.activeThreadId
      ) {
        const meta = this.threadStore.get(this.activeThreadId);
        const backing = meta?.backing.find(
          (b) => b.sessionId === notification.sessionId && b.agentId === cov.agentId,
        );
        if (meta && backing && this.model.entries.length > backing.coveredEntries) {
          backing.coveredEntries = this.model.entries.length;
          this.threadStore.updateMeta(meta.id, { backing: meta.backing });
        }
      }
    }
    // Metadata-bearing updates refresh the header/sessions list.
    const kind = notification.update.sessionUpdate;
    if (
      kind === "available_commands_update" ||
      kind === "current_mode_update" ||
      kind === "config_option_update" ||
      kind === "session_info_update" ||
      kind === "usage_update"
    ) {
      this.post({ type: "session", session: this.session });
      if (kind === "session_info_update") void this.listNativeSessions();
    }
  }

  async requestPermission(
    params: PermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const auto = vscode.workspace
      .getConfiguration("shipwreck")
      .get<string>("autoApprovePermissions", "never");
    const options = params.options;
    if (auto !== "never") {
      const pick =
        auto === "always"
          ? (options.find((o) => o.kind === "allow_always") ??
            options.find((o) => o.kind === "allow_once"))
          : options.find((o) => o.kind === "allow_once");
      if (pick) return { outcome: { outcome: "selected", optionId: pick.optionId } };
    }

    // No chat view visible — surface the request as a native notification so
    // background runs can still be approved. "Show" opens the chat card.
    if (!this.chatVisible) {
      const title = `${this.agentDisplayName()}: ${params.toolCall.title ?? "permission request"}`;
      const ranked = ["allow_once", "allow_always", "reject_once"]
        .map((k) => options.find((o) => o.kind === k))
        .filter((o): o is acp.PermissionOption => !!o)
        .concat(options.filter((o) => !/allow_once|allow_always|reject_once/.test(o.kind)))
        .slice(0, 3);
      const picked = await vscode.window.showInformationMessage(
        title,
        ...ranked.map((o) => o.name),
        "Show",
      );
      if (picked === "Show") {
        await this.focusChat();
        // fall through to the card path
      } else {
        const opt = ranked.find((o) => o.name === picked);
        return opt
          ? { outcome: { outcome: "selected", optionId: opt.optionId } }
          : { outcome: { outcome: "cancelled" } };
      }
    }

    const entryId = `perm-${++this.requestCounter}-${Date.now().toString(36)}`;
    const entry: ChatEntry = {
      id: entryId,
      kind: "permission",
      ts: Date.now(),
      requestKey: entryId,
      toolCall: {
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? undefined,
        name: params.toolCall.name ?? undefined,
        kind: params.toolCall.kind ?? undefined,
        status: params.toolCall.status ?? undefined,
        locations: params.toolCall.locations ?? undefined,
      },
      description: params.description,
      command: params.command,
      options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      state: "pending",
    };
    const bg = this.background.get(params.sessionId);
    if (bg) {
      bg.model.insertEntry(entry);
    } else {
      this.model.insertEntry(entry);
      if (this.session) {
        this.postClosed(this.session.sessionId);
        this.post({ type: "entryUpsert", sessionId: this.session.sessionId, entry });
      }
    }
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(entryId, { entryId, resolve });
      if (bg) this.backgroundNeedsInput(bg);
      this.onDidUpdateEmitter.fire();
    }).finally(() => this.onDidUpdateEmitter.fire());
  }

  resolvePermission(entryId: string, optionId?: string): void {
    const pending = this.pendingPermissions.get(entryId);
    if (!pending) return;
    const bg = this.backgroundTurnOf(entryId);
    this.pendingPermissions.delete(entryId);
    const entry = (bg?.model ?? this.model).entries.find((e) => e.id === entryId);
    if (entry && entry.kind === "permission") {
      entry.state = optionId ? "selected" : "cancelled";
      entry.selectedOptionId = optionId;
      if (!bg && this.session) {
        this.post({ type: "entryUpsert", sessionId: this.session.sessionId, entry });
      }
    }
    this.backgroundInputSettled(bg);
    pending.resolve(
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    );
  }

  async createElicitation(
    params: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    const mode = (params as { mode: string }).mode;
    const entryId = `elic-${++this.requestCounter}-${Date.now().toString(36)}`;

    if (mode === "url") {
      const url = (params as { url?: string }).url ?? "";
      const elicitationId = (params as { elicitationId?: string }).elicitationId;
      const entry: ChatEntry = {
        id: entryId,
        kind: "elicitation",
        ts: Date.now(),
        elicitationId,
        message: params.message,
        mode: "url",
        url,
        state: "pending",
      };
      const bg = this.placeInputEntry(params, entry);
      return new Promise<acp.CreateElicitationResponse>((resolve) => {
        this.pendingElicitations.set(entryId, { entryId, elicitationId, resolve });
        if (bg) this.backgroundNeedsInput(bg);
        this.onDidUpdateEmitter.fire();
      }).finally(() => this.onDidUpdateEmitter.fire());
    }

    if (mode === "form") {
      const schema = (params as { requestedSchema?: unknown }).requestedSchema;
      const entry: ChatEntry = {
        id: entryId,
        kind: "elicitation",
        ts: Date.now(),
        message: params.message,
        mode: "form",
        schema: schema as import("./types").ElicitationFormSchema | undefined,
        state: "pending",
      };
      const bg = this.placeInputEntry(params, entry);
      return new Promise<acp.CreateElicitationResponse>((resolve) => {
        this.pendingElicitations.set(entryId, { entryId, resolve });
        if (bg) this.backgroundNeedsInput(bg);
        this.onDidUpdateEmitter.fire();
      }).finally(() => this.onDidUpdateEmitter.fire());
    }

    // Unsupported mode — decline gracefully.
    return { action: "decline" };
  }

  /** Put an approval/input card in the transcript of the session that asked. */
  private placeInputEntry(params: object, entry: ChatEntry): RunningTurn | undefined {
    const sessionId = (params as { sessionId?: string }).sessionId;
    const bg = sessionId ? this.background.get(sessionId) : undefined;
    if (bg) {
      bg.model.insertEntry(entry);
      return bg;
    }
    this.model.insertEntry(entry);
    if (this.session) {
      this.postClosed(this.session.sessionId);
      this.post({ type: "entryUpsert", sessionId: this.session.sessionId, entry });
    }
    return undefined;
  }

  resolveElicitation(
    entryId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ): void {
    const pending = this.pendingElicitations.get(entryId);
    if (!pending) return;
    const bg = this.backgroundTurnOf(entryId);
    this.pendingElicitations.delete(entryId);
    const entry = (bg?.model ?? this.model).entries.find((e) => e.id === entryId);
    if (entry && entry.kind === "elicitation") {
      entry.state = action === "accept" ? "accepted" : action === "decline" ? "declined" : "cancelled";
      if (!bg && this.session) {
        this.post({ type: "entryUpsert", sessionId: this.session.sessionId, entry });
      }
    }
    this.backgroundInputSettled(bg);
    pending.resolve(
      action === "accept" ? { action: "accept", content } : { action },
    );
  }

  onElicitationComplete(params: acp.CompleteElicitationNotification): void {
    for (const [key, pending] of this.pendingElicitations) {
      if (pending.elicitationId === params.elicitationId) {
        const entry = this.model.entries.find((e) => e.id === pending.entryId);
        if (entry && entry.kind === "elicitation" && entry.state === "pending") {
          // The out-of-band interaction finished — keep awaiting user consent state,
          // but surface completion in the card.
          entry.message = `${entry.message}`;
        }
        if (this.session && entry) {
          this.post({ type: "entryUpsert", sessionId: this.session.sessionId, entry });
        }
      }
    }
  }

  onConnectionClosed(reason: string): void {
    if (this.connectionStatus === "disconnected") return;
    // AgentConnection guards its close callbacks during stop()/dispose(), so
    // reaching here means the agent died on its own — surface it immediately
    // (an in-flight prompt RPC settles via the closed connection's rejection).
    const agentId = this.activeAgentId;
    if (agentId) this.pool.forgetSessions(agentId);
    const token = this.connectToken;
    const duringStart = this.connectionStatus === "connecting";
    this.initializedAgentId = undefined;
    this.setConnection("error", reason);
    // Outstanding permission/elicitation RPCs will never resolve — cancel
    // them so the UI doesn't wait on a dead process. Other agents' background
    // turns keep theirs.
    this.cancelPendingInput((t) => !t || t.session.agentId === agentId);
    if (!agentId) return;
    const restart = () => {
      if (token !== this.connectToken || this.activeAgentId !== agentId) return;
      if (this.promptInFlight) {
        // Run when the turn releases the admission lock.
        this.pendingRestart = restart;
        return;
      }
      const now = Date.now();
      this.restartTimes = this.restartTimes.filter((t) => now - t < 60_000);
      if (this.restartTimes.length >= 3) return; // retryable via Retry button
      this.restartTimes.push(now);
      // Re-select the same agent — keeps the thread; never replays a prompt.
      void this.selectAgent(agentId);
    };
    if (this.promptInFlight) {
      this.pendingRestart = restart;
      return;
    }
    // A close racing an in-flight start is settled by that start's own
    // catch — don't launch a redundant restart on top of it.
    if (duringStart) return;
    restart();
  }

  private cancelPendingInput(which: (turn: RunningTurn | undefined) => boolean): void {
    for (const entryId of [...this.pendingPermissions.keys()]) {
      if (which(this.backgroundTurnOf(entryId))) this.resolvePermission(entryId);
    }
    for (const entryId of [...this.pendingElicitations.keys()]) {
      if (which(this.backgroundTurnOf(entryId))) this.resolveElicitation(entryId, "cancel");
    }
  }

  /** Callbacks for one pooled agent. The active agent drives the UI; an
   *  inactive one only reaches its own background turns, anything else is
   *  declined. */
  private delegateFor(agentId: string): ClientDelegate {
    const active = () => agentId === this.activeAgentId;
    const routed = (params: object) => {
      const sessionId = (params as { sessionId?: string }).sessionId;
      return active() || (!!sessionId && this.background.has(sessionId));
    };
    return {
      onSessionUpdate: (n) => {
        if (routed(n)) this.onSessionUpdate(n);
        else this.onSpareUpdate(agentId, n);
      },
      requestPermission: (params) =>
        routed(params)
          ? this.requestPermission(params)
          : Promise.resolve({ outcome: { outcome: "cancelled" } }),
      createElicitation: (params) =>
        routed(params) ? this.createElicitation(params) : Promise.resolve({ action: "cancel" }),
      onElicitationComplete: (params) => {
        if (active()) this.onElicitationComplete(params);
      },
      onConnectionClosed: (reason) => {
        this.pool.forgetSessions(agentId);
        if (active()) this.onConnectionClosed(reason);
        else this.cancelPendingInput((t) => t?.session.agentId === agentId);
      },
      onStderr: (text) => this.onStderr(text),
      beforeWriteFile: (sessionId, filePath) => this.changes.beforeWrite(sessionId, filePath),
    };
  }

  onStderr(text: string): void {
    console.debug("[acp agent stderr]", text.trimEnd());
  }

  /* ================= misc actions ================= */

  /** File text for embeddedContext blocks; null when absent/too big/non-file. */
  private async readAttachmentText(att: Attachment): Promise<string | null> {
    try {
      const uri = vscode.Uri.parse(att.uri);
      if (uri.scheme !== "file") return att.text ?? null;
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 200 * 1024) return null;
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      return null;
    }
  }

  async attach(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Attach",
    });
    if (!picked) return;
    await this.attachUris(picked.map((uri) => uri.toString()));
  }

  async openDiff(p: string, oldText: string | null | undefined, newText: string, title?: string): Promise<void> {
    const key = crypto.randomBytes(8).toString("hex");
    AcpDiffContentProvider.contents.set(key, oldText ?? "");
    const left = vscode.Uri.parse(`acp-diff:${encodeURIComponent(path.basename(p))}`).with({
      query: key,
    });
    const right = vscode.Uri.file(p);
    // If the file doesn't exist on disk yet, render both sides virtually.
    let rightDoc: vscode.Uri = right;
    try {
      await vscode.workspace.fs.stat(right);
    } catch {
      const key2 = crypto.randomBytes(8).toString("hex");
      AcpDiffContentProvider.contents.set(key2, newText);
      rightDoc = vscode.Uri.parse(`acp-diff:new-${encodeURIComponent(path.basename(p))}`).with({
        query: key2,
      });
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      rightDoc,
      title ?? `${path.basename(p)} (proposed changes)`,
      { preview: true },
    );
  }

  async openFile(raw: string, line?: number | null, column?: number | null): Promise<void> {
    const ref = parseFileRef(raw);
    const roots = [...new Set([this.session?.cwd, ...workspaceRoots()].filter((r): r is string => !!r))];
    const uri = await resolveFileRef(ref.path, roots).catch(() => undefined);
    if (!uri) {
      this.toast("warning", `Could not find ${ref.path}`);
      return;
    }
    const ln = line ?? ref.line;
    const col = column ?? ref.column;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (ln != null && ln > 0) {
        const l = Math.min(ln, doc.lineCount) - 1;
        const pos = new vscode.Position(l, Math.max(0, (col ?? 1) - 1));
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      this.toast("error", `Could not open ${ref.path}`);
    }
  }

  /* ================= turn changes ================= */

  /** Appends the turn's changes card to its thread once the turn ends. */
  private async recordChanges(turn: RunningTurn): Promise<void> {
    const entry = await this.changes.finish(turn.session.sessionId);
    if (!entry) return;
    await this.putEntry(turn.owner.threadId, turn.session.sessionId, entry);
  }

  /** Inserts or replaces an entry in a thread, on screen or stored. */
  private async putEntry(threadId: string, sessionId: string, entry: ChatEntry): Promise<void> {
    if (this.activeThreadId === threadId && this.session) {
      const i = this.model.entries.findIndex((e) => e.id === entry.id);
      if (i >= 0) this.model.entries[i] = entry;
      else this.model.insertEntry(entry);
      this.postClosed(this.session.sessionId);
      this.post({ type: "entryUpsert", sessionId: this.session.sessionId, entry });
      this.threadStore.setEntries(threadId, [...this.model.entries]);
      return;
    }
    const bg = this.background.get(sessionId);
    if (bg && bg.owner.threadId === threadId) {
      const i = bg.model.entries.findIndex((e) => e.id === entry.id);
      if (i >= 0) bg.model.entries[i] = entry;
      else bg.model.insertEntry(entry);
      this.threadStore.setEntries(threadId, [...bg.model.entries]);
      return;
    }
    if (!this.threadStore.get(threadId)) return;
    const stored = await this.threadStore.entriesOf(threadId);
    const i = stored.findIndex((e) => e.id === entry.id);
    this.threadStore.setEntries(threadId, i >= 0 ? stored.map((e, j) => (j === i ? entry : e)) : [...stored, entry]);
  }

  private changesEntry(entryId: string): Extract<ChatEntry, { kind: "changes" }> | undefined {
    const e = this.model.entries.find((x) => x.id === entryId);
    return e?.kind === "changes" ? e : undefined;
  }

  private gitPath?: Promise<string | undefined>;

  /** The Git the built-in Git extension uses, else whatever is on PATH. */
  private findGit = (): Promise<string | undefined> =>
    (this.gitPath ??= (async () => {
      try {
        const ext = vscode.extensions.getExtension("vscode.git");
        const exports = (ext?.isActive ? ext.exports : await ext?.activate()) as
          | { getAPI(v: 1): { git?: { path?: string } } }
          | undefined;
        const p = exports?.getAPI(1).git?.path;
        if (p) return p;
      } catch {
        /* Git extension disabled or not ready */
      }
      return "git";
    })());

  private diffUri = (label: string, content: string): vscode.Uri => {    const key = crypto.randomBytes(8).toString("hex");
    AcpDiffContentProvider.contents.set(key, content);
    return vscode.Uri.parse(`acp-diff:${encodeURIComponent(label)}`).with({ query: key });
  };

  async reviewTurnChanges(entryId: string, onlyPath?: string): Promise<void> {
    const record = await this.changes.load(entryId);
    if (!record) {
      this.toast("warning", "The changes from this turn are no longer available.");
      return;
    }
    await this.changes.review(record, this.diffUri, onlyPath);
  }

  async revertTurnChanges(entryId: string, onlyPath?: string): Promise<void> {
    const threadId = this.activeThreadId;
    const entry = this.changesEntry(entryId);
    const record = await this.changes.load(entryId);
    if (!record || !entry || !threadId) {
      this.toast("warning", "The changes from this turn are no longer available.");
      return;
    }
    const already = new Set(entry.reverted ?? []);
    const pending = { ...record, files: record.files.filter((f) => !already.has(f.path) && !entry.files.find((x) => x.path === f.path)?.kept) };
    const done = await this.changes.revert(pending, onlyPath);
    if (!done.length) return;
    const latest = this.changesEntry(entryId) ?? entry;
    await this.putEntry(threadId, this.session?.sessionId ?? "", {
      ...latest,
      reverted: [...new Set([...(latest.reverted ?? []), ...done])],
    });
  }

  private async handleEdits(m: Extract<WebviewMessage, { entryIds: string[] }>): Promise<void> {
    const threadId = this.activeThreadId;
    const model = this.model;
    const session = this.session;
    if (!threadId || (m.type !== "editsReview" && session?.busy)) return;
    const key = (p: string) => {
      const normalized = path.normalize(p);
      return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
    };
    const requested = new Set(m.entryIds);
    const entries = model.entries
      .filter((e): e is Extract<ChatEntry, { kind: "changes" }> => e.kind === "changes" && requested.has(e.id))
      .sort((a, b) => a.ts - b.ts);
    const pending = entries.map((entry) => {
      const reverted = new Set((entry.reverted ?? []).map(key));
      return {
        entry,
        paths: new Set(entry.files
          .filter((f) => !f.kept && !reverted.has(key(f.path)) && (!m.path || key(f.path) === key(m.path)))
          .map((f) => key(f.path))),
      };
    }).filter((p) => p.paths.size);
    if (!pending.length) return;
    let done = new Set(pending.flatMap((p) => [...p.paths]));
    if (m.type !== "editsKeep") {
      const records = await Promise.all(pending.map(async ({ entry, paths }) => {
        const record = await this.changes.load(entry.id);
        if (!record || [...paths].some((p) => !record.files.some((f) => key(f.path) === p))) return undefined;
        return { ...record, files: record.files.filter((f) => paths.has(key(f.path))) };
      }));
      if (this.activeThreadId !== threadId || this.model !== model || this.session !== session) return;
      if (records.some((r) => !r)) {
        this.toast("warning", "Some original file contents are no longer available. No changes were undone.");
        return;
      }
      const available = records.filter((r): r is NonNullable<typeof r> => !!r);
      if (m.type === "editsReview") {
        await this.changes.reviewMany(available, this.diffUri, m.path);
        return;
      }
      if (session?.busy) return;
      done = new Set((await this.changes.revertMany(available, m.path)).map(key));
    }
    if (!done.size) return;
    for (const { entry, paths } of pending) {
      const latest = model.entries.find((e) => e.id === entry.id);
      if (latest?.kind !== "changes") continue;
      const affected = latest.files.filter((f) => paths.has(key(f.path)) && done.has(key(f.path)));
      if (!affected.length) continue;
      await this.putEntry(threadId, session?.sessionId ?? "", m.type === "editsKeep"
        ? { ...latest, files: latest.files.map((f) => affected.includes(f) ? { ...f, kept: true } : f) }
        : { ...latest, reverted: [...new Set([...(latest.reverted ?? []), ...affected.map((f) => f.path)])] });
    }
  }

  private hydrateTerminals(entry: ChatEntry, threadId?: string): void {
    if (entry.kind !== "tool") return;
    for (const part of entry.tool.content ?? []) {
      if (part.type !== "terminal") continue;
      if (threadId) {
        this.terminalThreads.delete(part.terminalId);
        this.terminalThreads.set(part.terminalId, threadId);
        while (this.terminalThreads.size > 50) {
          this.terminalThreads.delete(this.terminalThreads.keys().next().value!);
        }
      }
      const snapshot = this.terminals.snapshot(part.terminalId);
      if (snapshot) {
        part.output = snapshot.output;
        part.truncated = snapshot.truncated;
        part.exitStatus = snapshot.exitStatus;
      }
    }
  }

  private async onTerminalOutput(snapshot: TerminalSnapshot, sessionId: string): Promise<void> {
    this.post({ type: "terminalOutput", ...snapshot });
    const turn = this.background.get(sessionId);
    const threadId = this.terminalThreads.get(snapshot.terminalId)
      ?? turn?.owner.threadId
      ?? (this.session?.sessionId === sessionId ? this.activeThreadId : undefined);
    if (!threadId || !this.threadStore.get(threadId)) return;
    let entries = this.activeThreadId === threadId
      ? this.model.entries
      : turn?.owner.threadId === threadId
        ? turn.model.entries
        : await this.threadStore.entriesOf(threadId);
    if (!this.threadStore.get(threadId)) return;
    if (this.activeThreadId === threadId) entries = this.model.entries;
    else {
      const background = [...this.background.values()].find((t) => t.owner.threadId === threadId);
      if (background) entries = background.model.entries;
    }
    const latest = this.terminals.snapshot(snapshot.terminalId) ?? snapshot;
    let changed = false;
    for (const entry of entries) {
      if (entry.kind !== "tool") continue;
      let entryChanged = false;
      for (const part of entry.tool.content ?? []) {
        if (part.type !== "terminal" || part.terminalId !== snapshot.terminalId) continue;
        part.output = latest.output;
        part.truncated = latest.truncated;
        part.exitStatus = latest.exitStatus;
        entryChanged = changed = true;
      }
      if (entryChanged && this.activeThreadId === threadId) {
        this.post({ type: "entryUpsert", sessionId: this.session?.sessionId ?? "", entry });
      }
    }
    if (changed) this.threadStore.setEntries(threadId, [...entries]);
  }

  revealTerminal(terminalId: string): void {
    this.terminals.reveal(terminalId);
  }

  /* ================= message dispatch ================= */

  private async onMessage(m: WebviewMessage, source?: vscode.Webview): Promise<void> {
    switch (m.type) {
      case "ready":
        this.postSnapshot(undefined, "full");
        this.editorContext.refresh();
        this.editorContext.publish(true);
        break;
      case "watchFiles":
        this.editorContext.watch(source ?? this, m.uris);
        break;
      case "setEditorContext":
        this.editorContext.setEnabled(m.uri, m.enabled);
        break;
      case "sendPrompt":
        await this.sendPrompt(m.text, m.attachments, m.requestId);
        break;
      case "cancel":
        this.cancelTurn();
        break;
      case "selectAgent":
        await this.selectAgent(m.agentId);
        break;
      case "newSession":
        await this.newSession();
        break;
      case "listSessions":
        await this.listNativeSessions();
        break;
      case "listNativeSessions":
        await this.listNativeSessions(m.all);
        break;
      case "openThread":
        await this.openThread(m.threadId);
        break;
      case "deleteThread":
        await this.deleteThread(m.threadId);
        break;
      case "renameThread":
        this.renameThread(m.threadId, m.title);
        break;
      case "setThreadPinned":
        this.setThreadPinned(m.threadId, m.pinned);
        break;
      case "setThreadArchived":
        this.setThreadArchived(m.threadId, m.archived);
        break;
      case "importSession":
        await this.importSession(m.agentId, m.sessionId, m.title);
        break;
      case "setThreadsScope":
        await this.setThreadsScope(m.scope);
        break;
      case "loadSession":
        await this.loadSession(m.sessionId);
        break;
      case "deleteSession":
        await this.deleteSession(m.sessionId);
        break;
      case "closeSession":
        await this.closeSession();
        break;
      case "setMode":
        await this.setMode(m.modeId);
        break;
      case "setConfigOption":
        await this.setConfigOption(m.configId, m.value);
        break;
      case "pickModel":
        await this.pickModel(m.agentId, m.value);
        break;
      case "probeAgents":
        this.probeAgents();
        break;
      case "authenticate":
        await this.authenticate(m.methodId);
        break;
      case "permissionResponse":
        this.resolvePermission(m.entryId, m.optionId);
        break;
      case "elicitationResponse":
        this.resolveElicitation(m.entryId, m.action, m.content);
        break;
      case "openDiff":
        await this.openDiff(m.path, m.oldText, m.newText, m.title);
        break;
      case "openFile":
        await this.openFile(m.path, m.line, m.column);
        break;
      case "reviewChanges":
        await this.reviewTurnChanges(m.entryId, m.path);
        break;
      case "revertChanges":
        await this.revertTurnChanges(m.entryId, m.path);
        break;
      case "editsReview":
      case "editsUndo":
      case "editsKeep":
        await this.handleEdits(m);
        break;
      case "revealTerminal":
        this.revealTerminal(m.terminalId);
        break;
      case "installAgent":
        if (this.installing.has(m.agentId)) break;
        this.installing.add(m.agentId);
        this.notifyAgentsChanged();
        try {
          await vscode.commands.executeCommand("shipwreck.installAgent", m.agentId);
        } finally {
          // Success or failure, the button must not stay stuck on "Installing…".
          this.installing.delete(m.agentId);
          this.notifyAgentsChanged();
        }
        if (!this.activeAgentId && this.installer.descriptors().some((a) => a.id === m.agentId && a.installed)) {
          await this.selectAgent(m.agentId);
        }
        break;
      case "uninstallAgent":
        await vscode.commands.executeCommand("shipwreck.uninstallAgent", m.agentId);
        break;
      case "refreshRegistry":
        await vscode.commands.executeCommand("shipwreck.refreshRegistry");
        break;
      case "browseRegistry":
        this.post({ type: "openCatalog" });
        break;
      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      case "gitCheckout":
        await vscode.commands.executeCommand("git.checkout");
        break;
      case "setPref": {
        const prefs = this.context.globalState.get<Record<string, unknown>>(
          "shipwreck.prefs",
          {},
        );
        await this.context.globalState.update("shipwreck.prefs", {
          ...prefs,
          [m.key]: m.value,
        });
        this.postSnapshot();
        break;
      }
      case "attach":
        await this.attach();
        break;
      case "mentionSearch":
        await this.mentionSearch(m.query);
        break;
      case "attachUris":
        await this.attachUris(m.uris);
        break;
    }
  }

  /* ================= lifecycle ================= */

  get activeId(): string | null {
    return this.activeAgentId;
  }

  private readonly installing = new Set<string>();

  private agentList(): AgentDescriptor[] {
    return this.installer
      .descriptors()
      .map((a) => (this.installing.has(a.id) ? { ...a, installing: true } : a));
  }

  /** Push the current agent list to all bound views. */
  notifyAgentsChanged(): void {
    this.reconcileAgents();
    this.post({ type: "agents", agents: this.agentList(), activeAgentId: this.activeAgentId });
    this.postSnapshot();
  }

  openCatalog(): void {
    this.post({ type: "openCatalog" });
  }

  closeView(): void {
    this.post({ type: "closeView" });
  }

  openHistory(): void {
    this.post({ type: "openHistory" });
    if (this.connection.connected) void this.listNativeSessions();
  }

  get listCapable(): boolean {
    return !!this.connection.initResponse?.agentCapabilities?.sessionCapabilities?.list;
  }

  agents(): AgentDescriptor[] {
    return this.installer.descriptors();
  }

  sessionList(): SessionSummary[] {
    return this.activeAgentId ? this.nativeSessionsByAgent.get(this.activeAgentId) ?? [] : [];
  }

  private reconcileAgents(): void {
    const installed = new Set(this.installer.descriptors().filter((a) => a.installed).map((a) => a.id));
    const last = this.context.globalState.get<string>("shipwreck.lastAgent");
    if (last && !installed.has(last)) void this.context.globalState.update("shipwreck.lastAgent", undefined);
    for (const id of this.nativeSessionsByAgent.keys()) {
      if (!installed.has(id)) this.nativeSessionsByAgent.delete(id);
    }
    for (const id of this.spares.keys()) {
      if (!installed.has(id)) this.spares.delete(id);
    }
    if (this.activeAgentId && !installed.has(this.activeAgentId)) {
      this.cancelTurn();
      this.sendTurnToBackground();
      this.persistThread(false);
      ++this.connectToken;
      this.activeAgentId = null;
      this.pool.setActive(null);
      this.initializedAgentId = undefined;
      this.pendingAgentId = undefined;
      this.activeThreadId = undefined;
      this.session = null;
      this.model.reset();
      this.connectionStatus = "disconnected";
      this.connectionDetail = undefined;
      this.post({ type: "closeView" });
    }
    this.pool.retain(installed);
  }

  dispose(): void {
    if (this.appendTimer) clearTimeout(this.appendTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.gitSub?.dispose();
    for (const d of this.disposables) d.dispose();
    this.pool.dispose();
    disposeTiming();
  }
}

/** Renders oldText for `vscode.diff` left-hand documents. */
export class AcpDiffContentProvider implements vscode.TextDocumentContentProvider {
  static readonly contents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return AcpDiffContentProvider.contents.get(uri.query) ?? "";
  }
}

/* ================= webview view / panel ================= */

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "main.webview.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "styles.css"),
  );
  const nonce = crypto.randomBytes(16).toString("hex");
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    `connect-src https:`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>Shipwreck</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "shipwreck.chat";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: ChatController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        this.context.globalStorageUri,
      ],
    };
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri);
    this.controller.chatViewId = view.viewType;
    this.controller.bind(view.webview, view.viewType);
    const setVisible = (v: boolean) => {
      void vscode.commands.executeCommand("setContext", "acpChatVisible", v);
      this.controller.setChatVisible(v);
    };
    setVisible(view.visible);
    view.onDidChangeVisibility(() => setVisible(view.visible));
    view.onDidDispose(() => {
      this.controller.unbind(view.webview);
      setVisible(false);
    });
  }
}

export function openChatPanel(
  context: vscode.ExtensionContext,
  controller: ChatController,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "shipwreck.chatPanel",
    "Shipwreck",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist"),
        vscode.Uri.joinPath(context.extensionUri, "media"),
        context.globalStorageUri,
      ],
    },
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "brand", "icon-128.png");
  panel.webview.html = webviewHtml(panel.webview, context.extensionUri);
  controller.bind(panel.webview);
  panel.onDidDispose(() => controller.unbind(panel.webview));
  return panel;
}
