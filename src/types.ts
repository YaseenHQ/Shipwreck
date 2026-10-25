/**
 * Shared types between the extension host and the chat webview.
 * This file must not import "vscode" or "@agentclientprotocol/sdk" — it is
 * bundled into the webview and defines the wire protocol between the two.
 */

/** How an agent is launched. */
export type DistributionKind = "npx" | "uvx" | "binary" | "custom";

export interface AgentDescriptor {
  /** Stable identifier: registry id, or `custom:<name>` for user-configured agents. */
  id: string;
  name: string;
  description?: string;
  version?: string;
  /** Icon URL (registry CDN) or absolute file path. */
  icon?: string;
  /** Sanitized icon as a data URI (data:image/svg+xml;base64,…). */
  iconSvg?: string;
  /** True when iconSvg only uses currentColor/none/absent colors — safe to mask. */
  iconMono?: boolean;
  source: "registry" | "custom";
  installed: boolean;
  installKind?: DistributionKind;
  /** Runtime the distribution needs, if any. */
  requires?: "node" | "uv" | null;
  /** An install started from the chat is still running. */
  installing?: boolean;
}

export interface InstalledAgentRecord {
  id: string;
  name: string;
  version?: string;
  kind: DistributionKind;
  /** For binary installs: directory containing the extracted archive. */
  installDir?: string;
  /** Command argv resolved at launch time (recomputed on update). */
  command: string;
  args: string[];
  env?: Record<string, string>;
  installedAt: number;
}

export interface CustomAgentConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Optional local SVG icon path. */
  icon?: string;
}

/* ---------- app threads (canonical; agent sessions are backing handles) ---------- */

export interface ThreadBacking {
  agentId: string;
  sessionId: string;
  coveredEntries: number;
  lastUsedAt: number;
}

export interface ThreadMeta {
  id: string;
  title: string;
  /** User-renamed; agent titles never overwrite it. */
  titleIsUser?: boolean;
  workspace?: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  archived?: boolean;
  agents: string[];
  backing: ThreadBacking[];
  source?: { kind: "acp-import"; agentId: string; sessionId: string };
  preview?: string;
}

/* ---------- session view model ---------- */

export interface ModeInfo {
  id: string;
  name: string;
  description?: string | null;
}

export interface ConfigOptionInfo {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: "select" | "boolean";
  currentValue: string | boolean;
  /** Flattened options for select. */
  options?: {
    value: string;
    name: string;
    description?: string | null;
    group?: string;
    groupId?: string;
  }[];
}

export interface AgentModel {
  value: string;
  name: string;
  description?: string | null;
  group?: string;
}

/** What the model picker knows about one installed agent's models. */
export interface AgentModels {
  agentId: string;
  /** probing keeps the last known models while a fresh list is fetched. */
  status: "ready" | "probing" | "auth_required" | "error";
  /** Config option that selects the model; absent when the agent offers no choice. */
  configId?: string;
  models: AgentModel[];
  currentValue?: string;
  /** Model picked for this agent in the picker; applied to its new sessions. */
  preferredValue?: string;
  message?: string;
  checkedAt: number;
}

export interface UsageInfo {
  used: number;
  size: number;
  cost?: { amount: number; currency: string } | null;
}

export interface SessionMeta {
  sessionId: string;
  agentId: string;
  title?: string | null;
  cwd: string;
  modes?: { currentModeId: string; availableModes: ModeInfo[] } | null;
  configOptions?: ConfigOptionInfo[];
  availableCommands?: { name: string; description?: string | null; inputHint?: string | null }[];
  usage?: UsageInfo | null;
  busy: boolean;
  createdAt: number;
  restored?: boolean;
}

/* ---------- chat entries ---------- */

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; fileContext?: FileContext }
  | { type: "resource"; uri: string; text?: string; mimeType?: string; fileContext?: FileContext }
  | { type: "audio"; data: string; mimeType: string };

export interface ToolCallState {
  toolCallId: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | string;
  content?: ToolCallContentState[];
  locations?: { path: string; line?: number | null }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type ToolCallContentState =
  | { type: "content"; content: Part }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string; output?: string; truncated?: boolean; exitStatus?: { exitCode: number | null; signal: string | null } | null };

export interface TerminalSnapshot {
  terminalId: string;
  output: string;
  truncated: boolean;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
  live: boolean;
}

export type ChatEntry =
  | { id: string; kind: "user"; ts: number; parts: Part[]; local?: boolean }
  | { id: string; kind: "agent"; ts: number; parts: Part[]; streaming?: boolean; agentId?: string }
  | { id: string; kind: "thought"; ts: number; parts: Part[]; streaming?: boolean }
  | { id: string; kind: "tool"; ts: number; tool: ToolCallState; agentId?: string }
  | { id: string; kind: "plan"; ts: number; planId?: string; entries: PlanItem[]; agentId?: string }
  | { id: string; kind: "notice"; ts: number; severity: string; title: string; description?: string | null }
  | { id: string; kind: "marker"; ts: number; text: string; state?: string; summary?: string }
  | {
      id: string;
      kind: "handoff";
      ts: number;
      toAgentId: string;
      fromAgents: string[];
      included: number;
      omitted: number;
      text: string;
    }
  | {
      id: string;
      kind: "permission";
      ts: number;
      requestKey: string;
      toolCall: ToolCallState;
      description?: string;
      command?: string;
      options: { optionId: string; name: string; kind: string }[];
      state: "pending" | "selected" | "cancelled";
      selectedOptionId?: string;
    }
  | {
      id: string;
      kind: "elicitation";
      ts: number;
      elicitationId?: string;
      message: string;
      mode: string;
      url?: string;
      schema?: ElicitationFormSchema;
      state: "pending" | "accepted" | "declined" | "cancelled";
    }
  /** Files the agent changed in one turn, appended when the turn ends. */
  | {
      id: string;
      kind: "changes";
      ts: number;
      files: ChangedFile[];
      /** Paths whose changes were undone from this card. */
      reverted?: string[];
    };

export interface ChangedFile {
  path: string;
  add: number;
  del: number;
  kept?: boolean;
  /** The file did not exist before the turn. */
  created?: boolean;
}

export interface PlanItem {
  content: string;
  priority?: "high" | "medium" | "low" | string;
  status?: "pending" | "in_progress" | "completed" | string;
}

export interface ElicitationFormSchema {
  title?: string | null;
  description?: string | null;
  required?: string[];
  properties?: Record<
    string,
    {
      type?: string;
      title?: string;
      description?: string;
      default?: unknown;
      enum?: unknown[];
      minimum?: number;
      maximum?: number;
      minLength?: number;
      maxLength?: number;
      items?: { type?: string; enum?: unknown[] };
    }
  >;
}

export type AttachmentKind = "file" | "folder" | "selection" | "terminal" | "diagnostic";

export interface FileContext {
  diagnostics: {
    error: number;
    warning: number;
    items: { line: number; severity: "error" | "warning"; code?: string; message: string }[];
  };
  git?: "M" | "A" | "U";
}

export interface EditorContext extends FileContext {
  uri: string;
  name: string;
  selection?: { range: { startLine: number; endLine: number }; text: string };
}

interface AttachmentBase {
  uri: string;
  name: string;
  range?: { startLine: number; endLine: number };
  text?: string;
  mimeType?: string;
  fileContext?: FileContext;
  contextSource?: "active-editor";
}

export type Attachment = AttachmentBase & (
  | { kind?: AttachmentKind }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "text-file"; text: string; mimeType: string }
  | { kind: "rejected"; error: string }
);

export interface MentionResult {
  uri: string;
  name: string;
  path: string;
}

/** A thread whose agent is working (or finished) while another thread is on screen. */
export interface ThreadActivity {
  threadId: string;
  agentId: string;
  /** done/failed/needs_input stay until the user opens the thread. */
  state: "running" | "needs_input" | "done" | "failed";
  updatedAt: number;
}

/* ---------- host -> webview ---------- */

export type HostMessage =
  | ({ type: "terminalOutput" } & TerminalSnapshot)
  | { type: "snapshot"; payload: Snapshot }
  | { type: "session"; session: SessionMeta | null }
  | { type: "entryUpsert"; sessionId: string; entry: ChatEntry }
  | { type: "entriesReplace"; sessionId: string; entries: ChatEntry[] }
  /** Streaming delta: append text to entries[entryId].parts[partIndex] (a text part). */
  | { type: "entryAppend"; sessionId: string; entryId: string; partIndex: number; text: string }
  | { type: "threadActivity"; activity: ThreadActivity[] }
  | { type: "agents"; agents: AgentDescriptor[]; activeAgentId?: string | null }
  | { type: "threads"; threads: ThreadMeta[]; activeThreadId?: string }
  | { type: "nativeSessions"; agentId: string; sessions: SessionSummary[] }
  | { type: "busy"; sessionId: string; busy: boolean }
  | { type: "toast"; level: "info" | "warning" | "error"; text: string }
  | { type: "attachment"; attachment: Attachment }
  | { type: "focusComposer" }
  | { type: "openCatalog" }
  | { type: "openHistory" }
  | { type: "closeView" }
  | { type: "workspace"; workspace?: WorkspaceInfo }
  | { type: "connection"; agentId: string; status: ConnectionStatus; detail?: string }
  | { type: "editorContext"; context?: EditorContext; enabled: boolean }
  | { type: "fileContext"; uri: string; context: FileContext }
  | { type: "mentionResults"; results: MentionResult[] }
  | { type: "promptAccepted"; requestId: string }
  | { type: "promptRejected"; requestId: string; reason?: string }
  | { type: "agentModels"; agentModels: AgentModels[] };

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "auth_required" | "error";

export interface SessionSummary {
  sessionId: string;
  title?: string | null;
  cwd: string;
  updatedAt?: string | null;
}

export interface AuthMethodInfo {
  id: string;
  name: string;
  description?: string | null;
  type: "agent" | "terminal";
}

export interface WorkspaceInfo {
  folders: { name: string; path: string }[];
  branch?: string;
}

export interface Snapshot {
  activeAgentId: string | null;
  activeThreadId?: string;
  workspace?: WorkspaceInfo;
  prefs?: Record<string, unknown>;
  threads: ThreadMeta[];
  nativeSessions?: SessionSummary[];
  threadsScope?: "workspace" | "all";
  threadsImport?: boolean;
  showCost?: boolean;
  /** Agent selected to continue the open thread (context handoff pending). */
  pendingAgentId?: string;
  agents: AgentDescriptor[];
  connection: { status: ConnectionStatus; detail?: string };
  authMethods?: AuthMethodInfo[];
  session?: SessionMeta | null;
  /** Omitted when unchanged since the last snapshot; keep the current entries. */
  entries?: ChatEntry[];
  canLoadSession: boolean;
  canListSessions: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  activity?: ThreadActivity[];
  agentModels?: AgentModels[];
}

/* ---------- webview -> host ---------- */

export type WebviewMessage =
  | { type: "ready" }
  | { type: "setEditorContext"; uri: string; enabled: boolean }
  | { type: "watchFiles"; uris: string[] }
  | { type: "sendPrompt"; text: string; attachments?: Attachment[]; requestId?: string }
  | { type: "cancel" }
  | { type: "selectAgent"; agentId: string }
  | { type: "newSession" }
  | { type: "listSessions" }
  | { type: "route"; view: "chat" | "catalog" | "threads" }
  | { type: "loadSession"; sessionId: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "closeSession" }
  | { type: "openThread"; threadId: string }
  | { type: "deleteThread"; threadId: string }
  | { type: "renameThread"; threadId: string; title: string }
  | { type: "setThreadPinned"; threadId: string; pinned: boolean }
  | { type: "setThreadArchived"; threadId: string; archived: boolean }
  | { type: "importSession"; agentId: string; sessionId: string; title?: string }
  | { type: "listNativeSessions"; all?: boolean }
  | { type: "setThreadsScope"; scope: "workspace" | "all" }
  | { type: "setMode"; modeId: string }
  | { type: "setConfigOption"; configId: string; value: string | boolean }
  /** Switch to the agent if needed, then select the model (omitted: just the agent). */
  | { type: "pickModel"; agentId: string; value?: string }
  /** Refresh model lists of agents that have none or a stale one. */
  | { type: "probeAgents" }
  | { type: "authenticate"; methodId?: string }
  | { type: "permissionResponse"; entryId: string; optionId?: string }
  | { type: "elicitationResponse"; entryId: string; action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }
  | { type: "openDiff"; path: string; oldText?: string | null; newText: string; title?: string }
  /** `path` may be absolute, workspace-relative, or carry a `:line[:col]` / `#Lline` suffix. */
  | { type: "openFile"; path: string; line?: number | null; column?: number | null }
  /** Open the turn's changes in the multi-file diff editor (`path`: just that file). */
  | { type: "reviewChanges"; entryId: string; path?: string }
  /** Restore files to their content before the turn (`path`: just that file). Asks first. */
  | { type: "revertChanges"; entryId: string; path?: string }
  | { type: "editsReview" | "editsUndo" | "editsKeep"; entryIds: string[]; path?: string }
  | { type: "revealTerminal"; terminalId: string }
  | { type: "installAgent"; agentId: string }
  | { type: "uninstallAgent"; agentId: string }
  | { type: "refreshRegistry" }
  | { type: "browseRegistry" }
  | { type: "openExternal"; url: string }
  | { type: "gitCheckout" }
  | { type: "setPref"; key: string; value: unknown }
  | { type: "mentionSearch"; query: string }
  | { type: "attachUris"; uris: string[] }
  | { type: "attach" };
