import { useSyncExternalStore } from "react";
import type {
  AgentDescriptor,
  AgentModels,
  Attachment,
  EditorContext,
  AuthMethodInfo,
  ChatEntry,
  ConnectionStatus,
  HostMessage,
  MentionResult,
  SessionMeta,
  SessionSummary,
  ThreadActivity,
  ThreadMeta,
  TerminalSnapshot,
  WebviewMessage,
  WorkspaceInfo,
} from "../src/types";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };

const api = acquireVsCodeApi();

export function post(msg: WebviewMessage): void {
  api.postMessage(msg);
}

/* Keyed prefs persisted host-side (context.globalState "shipwreck.prefs"),
   delivered with each snapshot. */
export function getPref<T>(key: string, fallback: T): T {
  return (state.prefs[key] as T | undefined) ?? fallback;
}

export function setPref(key: string, value: unknown): void {
  setState({ prefs: { ...state.prefs, [key]: value } });
  post({ type: "setPref", key, value });
}

export interface Toast {
  id: number;
  level: "info" | "warning" | "error";
  text: string;
}

export interface State {
  ready: boolean;
  agents: AgentDescriptor[];
  activeAgentId: string | null;
  connection: { status: ConnectionStatus; detail?: string };
  authMethods: AuthMethodInfo[];
  session: SessionMeta | null;
  entries: ChatEntry[];
  threads: ThreadMeta[];
  activeThreadId?: string;
  nativeSessions: SessionSummary[];
  threadsScope: "workspace" | "all";
  threadsImport: boolean;
  showCost: boolean;
  pendingAgentId?: string;
  canLoadSession: boolean;
  canListSessions: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  toasts: Toast[];
  attachments: Attachment[];
  editorContext?: EditorContext;
  editorContextEnabled: boolean;
  mentionResults: MentionResult[];
  workspace?: WorkspaceInfo;
  prefs: Record<string, unknown>;
  /** Threads working or finished off screen (background turns). */
  activity: ThreadActivity[];
  /** Model lists of installed agents, for the model picker. */
  agentModels: AgentModels[];
  terminals: Record<string, TerminalSnapshot>;
}

const initial: State = {
  ready: false,
  activeAgentId: null,
  agents: [],
  connection: { status: "disconnected" },
  authMethods: [],
  session: null,
  entries: [],
  threads: [],
  nativeSessions: [],
  threadsScope: "workspace",
  threadsImport: true,
  showCost: false,
  canLoadSession: false,
  canListSessions: false,
  toasts: [],
  attachments: [],
  editorContextEnabled: true,
  mentionResults: [],
  prefs: {},
  activity: [],
  agentModels: [],
  terminals: {},
};

let state: State = initial;
const listeners = new Set<() => void>();
let toastId = 0;

function setState(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/* Streaming touches the last few entries; search from the end. */
function indexOfEntry(id: string): number {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    if (state.entries[i].id === id) return i;
  }
  return -1;
}

function upsertEntry(entry: ChatEntry): void {
  const idx = indexOfEntry(entry.id);
  const entries = state.entries.slice();
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  setState({ entries });
}

function appendToEntry(entryId: string, partIndex: number, text: string): void {
  const idx = indexOfEntry(entryId);
  if (idx < 0) return;
  const entry = state.entries[idx];
  if (!("parts" in entry)) return;
  const parts = entry.parts.slice();
  const part = parts[partIndex];
  if (part && part.type === "text") parts[partIndex] = { type: "text", text: part.text + text };
  else if (partIndex === parts.length) parts.push({ type: "text", text });
  else return;
  const entries = state.entries.slice();
  entries[idx] = { ...entry, parts } as ChatEntry;
  setState({ entries });
}

function toast(level: Toast["level"], text: string): void {
  const t = { id: ++toastId, level, text };
  setState({ toasts: [...state.toasts.slice(-4), t] });
  setTimeout(() => setState({ toasts: state.toasts.filter((x) => x.id !== t.id) }), 6000);
}

export function handleHostMessage(m: HostMessage): void {
  switch (m.type) {
    case "terminalOutput": {
      const terminals = { ...state.terminals };
      delete terminals[m.terminalId];
      terminals[m.terminalId] = m;
      const ids = Object.keys(terminals);
      for (const id of ids.slice(0, Math.max(0, ids.length - 50))) delete terminals[id];
      setState({ terminals });
      break;
    }
    case "snapshot": {
      const p = m.payload;
      setState({
        ready: true,
        agents: p.agents,
        activeAgentId: p.activeAgentId ?? null,
        connection: p.connection,
        authMethods: p.authMethods ?? [],
        session: p.session ?? null,
        entries: p.entries ?? state.entries,
        threads: p.threads ?? [],
        nativeSessions: p.nativeSessions ?? [],
        activeThreadId: p.activeThreadId,
        threadsScope: p.threadsScope ?? "workspace",
        threadsImport: p.threadsImport ?? true,
        showCost: p.showCost ?? false,
        pendingAgentId: p.pendingAgentId,
        canLoadSession: p.canLoadSession,
        canListSessions: p.canListSessions,
        promptCapabilities: p.promptCapabilities,
        workspace: p.workspace,
        prefs: p.prefs ?? {},
        activity: p.activity ?? state.activity,
        agentModels: p.agentModels ?? state.agentModels,
      });
      break;
    }
    case "session":
      setState({ session: m.session });
      break;
    case "entryUpsert":
      upsertEntry(m.entry);
      break;
    case "entriesReplace":
      setState({ entries: m.entries });
      break;
    case "entryAppend":
      appendToEntry(m.entryId, m.partIndex, m.text);
      break;
    case "threadActivity":
      setState({ activity: m.activity });
      break;
    case "agentModels":
      setState({ agentModels: m.agentModels });
      break;
    case "agents":
      setState({
        agents: m.agents,
        activeAgentId: m.activeAgentId === undefined ? state.activeAgentId : m.activeAgentId,
        nativeSessions: m.activeAgentId === undefined || m.activeAgentId === state.activeAgentId
          ? state.nativeSessions : [],
      });
      break;
    case "threads":
      setState({ threads: m.threads, activeThreadId: m.activeThreadId ?? state.activeThreadId });
      break;
    case "nativeSessions":
      if (m.agentId === state.activeAgentId) setState({ nativeSessions: m.sessions });
      break;
    case "busy":
      if (state.session && state.session.sessionId === m.sessionId) {
        setState({ session: { ...state.session, busy: m.busy } });
      }
      break;
    case "toast":
      toast(m.level, m.text);
      break;
    case "attachment":
      setState({ attachments: [...state.attachments, m.attachment] });
      break;
    case "focusComposer":
      window.dispatchEvent(new CustomEvent("acp:focus-composer"));
      break;
    case "connection":
      setState({ connection: { status: m.status, detail: m.detail } });
      break;
    case "workspace":
      setState({ workspace: m.workspace });
      break;
    case "editorContext":
      setState({ editorContext: m.context, editorContextEnabled: m.enabled });
      break;
    case "fileContext":
      setState({ attachments: state.attachments.map((a) => a.uri === m.uri ? { ...a, fileContext: m.context } : a) });
      break;
    case "mentionResults":
      setState({ mentionResults: m.results });
      break;
    case "promptAccepted": {
      const cb = ackWaiters.get(m.requestId);
      ackWaiters.delete(m.requestId);
      cb?.(true);
      break;
    }
    case "promptRejected": {
      const cb = ackWaiters.get(m.requestId);
      ackWaiters.delete(m.requestId);
      cb?.(false, m.reason);
      break;
    }
  }
}

const ackWaiters = new Map<string, (ok: boolean, reason?: string) => void>();

/** Resolve once the host accepts or rejects a sendPrompt carrying requestId.
 *  Returns an unsubscribe — callers drop it on settle and on unmount so a
 *  late/duplicate ack can never touch a newer pending send. */
export function onPromptAck(
  requestId: string,
  cb: (ok: boolean, reason?: string) => void,
): () => void {
  ackWaiters.set(requestId, cb);
  return () => {
    if (ackWaiters.get(requestId) === cb) ackWaiters.delete(requestId);
  };
}

export function removeAttachment(uri: string): void {
  setState({ attachments: state.attachments.filter((a) => a.uri !== uri) });
}

export function addAttachment(att: Attachment): void {
  if (state.attachments.some((a) => a.uri === att.uri && a.range?.startLine === att.range?.startLine && a.range?.endLine === att.range?.endLine)) return;
  setState({ attachments: [...state.attachments, att] });
}

export function mentionSearch(query: string): void {
  post({ type: "mentionSearch", query });
}

export function attachUris(uris: string[]): void {
  post({ type: "attachUris", uris });
}

export function clearAttachments(): void {
  setState({ attachments: [] });
}

/** Remove exactly the submitted set (attachments added since submission stay). */
export function removeAttachments(atts: Attachment[]): void {
  const same = (a: Attachment, b: Attachment) =>
    a.uri === b.uri &&
    a.range?.startLine === b.range?.startLine &&
    a.range?.endLine === b.range?.endLine;
  const pending = new Set(atts);
  setState({
    attachments: state.attachments.filter((a) => {
      for (const b of pending) {
        if (same(a, b)) {
          pending.delete(b);
          return false;
        }
      }
      return true;
    }),
  });
}

/** Current state without subscribing (for selector hooks). */
export function getState(): State {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useStore(): State {
  return useSyncExternalStore(subscribe, () => state);
}

window.addEventListener("message", (e: MessageEvent) => {
  handleHostMessage(e.data as HostMessage);
});

post({ type: "ready" });
