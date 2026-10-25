import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getState, post, useStore } from "./store";
import { Composer } from "./components/Composer";
import { PartsView } from "./components/Parts";
import { ToolCallCard } from "./components/ToolCall";
import { PermissionCard, ElicitationCard, PlanCard } from "./components/Cards";
import { ChangesCard } from "./components/Changes";
import { EditsBar } from "./components/EditsBar";
import { AgentCard, Catalog } from "./components/Catalog";
import { Threads, ThreadRow } from "./components/Threads";
import { AgentLogo } from "./components/AgentLogo";
import { activityByThread } from "./components/Activity";
import type { AgentDescriptor, ChatEntry, Part } from "../src/types";
import {
  IconArrowDown,
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconHandoff,
  IconInfo,
  IconKey,
  IconPackage,
  IconShipwreck,
  IconWarning,
} from "./icons";

function textOf(parts: Part[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim();
}

function MsgActions({
  getText,
  ts,
  className,
}: {
  getText: () => string;
  ts: number;
  className: string;
}): React.JSX.Element {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(t);
  }, [done]);
  const at = new Date(ts);
  return (
    <div className={`msg-actions ${className}`}>
      <button
        className="msg-action"
        title={done ? "Copied" : "Copy"}
        aria-label={done ? "Copied" : "Copy"}
        onClick={() => {
          void navigator.clipboard.writeText(getText());
          setDone(true);
        }}
      >
        {done ? <IconCheck size={12} className="ok" /> : <IconCopy size={12} />}
      </button>
      <time className="msg-time" dateTime={at.toISOString()} title={at.toLocaleString()}>
        {at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </time>
    </div>
  );
}

/** Agent text of the turn that ends at `endId`, read on demand. */
function turnText(endId: string): string {
  const { entries } = getState();
  const out: string[] = [];
  for (let i = entries.findIndex((e) => e.id === endId); i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "user") break;
    if (e.kind === "agent") {
      const t = textOf(e.parts);
      if (t) out.unshift(t);
    }
  }
  return out.join("\n\n");
}

interface TurnEnd {
  ts: number;
  last: boolean;
}

/** The entry each finished agent turn ends on, keyed by id. A turn without agent
    text gets no actions, and the turn still running gets none. */
function turnEnds(entries: ChatEntry[], busy: boolean): Map<string, TurnEnd> {
  const ends = new Map<string, TurnEnd>();
  let anchor: string | undefined;
  let ts = 0;
  const close = (last: boolean) => {
    if (anchor && ts) ends.set(anchor, { ts, last });
    anchor = undefined;
    ts = 0;
  };
  for (const e of entries) {
    if (e.kind === "user") {
      close(false);
      continue;
    }
    if (e.kind === "agent" && textOf(e.parts)) ts = e.ts;
    if (e.kind !== "changes") anchor = e.id;
  }
  if (!busy) close(true);
  return ends;
}

function AgentMessage({
  entry,
  live,
}: {
  entry: Extract<ChatEntry, { kind: "agent" }>;
  live: boolean;
}): React.JSX.Element {
  return (
    <div className={`msg agent${live ? " live" : ""}`}>
      <PartsView parts={entry.parts} links="files" />
      {live && <span className="cursor" aria-hidden="true" />}
    </div>
  );
}

function EntryBody({
  entry,
  live,
  agentName,
}: {
  entry: ChatEntry;
  live: boolean;
  agentName?: string;
}): React.JSX.Element | null {
  if ((entry.kind === "user" || entry.kind === "agent" || entry.kind === "thought") && !entry.parts.length) {
    return null;
  }
  switch (entry.kind) {
    case "user":
      return (
        <>
          <div className="msg user">
            <PartsView parts={entry.parts} />
          </div>
          <MsgActions className="user-actions" ts={entry.ts} getText={() => textOf(entry.parts)} />
        </>
      );
    case "agent":
      return <AgentMessage entry={entry} live={live} />;
    case "thought":
      return <Thought entry={entry} />;
    case "tool":
      return <ToolCallCard tool={entry.tool} />;
    case "plan":
      return <PlanCard entry={entry} />;
    case "notice":
      return (
        <div
          className={`row-head notice ${entry.severity}`}
          role={entry.severity === "error" ? "alert" : undefined}
        >
          <span className="row-ic notice-ic">
            {entry.severity === "error" || entry.severity === "warning" ? (
              <IconWarning size={14} />
            ) : (
              <IconInfo size={14} />
            )}
          </span>
          <div className="notice-text">
            <div className="notice-title">{entry.title}</div>
            {entry.description && <div className="notice-desc">{entry.description}</div>}
          </div>
        </div>
      );
    case "marker":
      return entry.summary ? (
        <Marker text={entry.text} summary={entry.summary} />
      ) : (
        <div className="divider marker">
          <span>{entry.text}</span>
        </div>
      );
    case "handoff":
      return <HandoffDivider entry={entry} name={agentName ?? entry.toAgentId} />;
    case "permission":
      return <PermissionCard entry={entry} />;
    case "elicitation":
      return <ElicitationCard entry={entry} />;
    case "changes":
      return <ChangesCard entry={entry} />;
    default:
      return null;
  }
}

/* Entries keep object identity until the host replaces them, so memo skips
   every row a streaming delta did not touch. */
const EntryView = memo(function EntryView({
  endTs,
  endLast,
  ...props
}: {
  entry: ChatEntry;
  live: boolean;
  agentName?: string;
  endTs?: number;
  endLast?: boolean;
}): React.JSX.Element {
  return (
    <div className={`entry entry-${props.entry.kind}`}>
      <EntryBody {...props} />
      {endTs !== undefined && (
        <MsgActions
          className={`turn-actions${endLast ? " last" : ""}`}
          ts={endTs}
          getText={() => turnText(props.entry.id)}
        />
      )}
    </div>
  );
});

function Marker({ text, summary }: { text: string; summary: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`handoff${open ? " open" : ""}`}>
      <button className="divider handoff-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          {text}
          <IconChevronRight size={10} className="row-caret" />
        </span>
      </button>
      {open && <pre className="handoff-body">{summary}</pre>}
    </div>
  );
}

function Thought({
  entry,
}: {
  entry: Extract<ChatEntry, { kind: "thought" }>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => {
    if (open) return "";
    const flat = textOf(entry.parts).replace(/\s+/g, " ");
    return entry.streaming ? flat.slice(-160) : flat.slice(0, 160);
  }, [entry.parts, entry.streaming, open]);
  return (
    <div className={`thought${open ? " open" : ""}`}>
      <button
        className={`row-head thought-head${entry.streaming ? " streaming" : ""}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="row-ic">
          <IconBrain size={14} />
        </span>
        <span className="thought-label">{entry.streaming ? "Thinking" : "Thought"}</span>
        {!open && <span className="thought-preview">{preview}</span>}
        <IconChevronRight size={10} className="row-caret" />
      </button>
      {open && (
        <div className="row-body thought-body">
          <PartsView parts={entry.parts} />
        </div>
      )}
    </div>
  );
}

function HandoffDivider({
  entry,
  name,
}: {
  entry: Extract<ChatEntry, { kind: "handoff" }>;
  name: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`handoff${open ? " open" : ""}`}>
      <button className="divider handoff-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          <IconHandoff size={12} />
          Continued with <b>{name}</b> · {entry.included} message
          {entry.included === 1 ? "" : "s"} of context
          {entry.omitted > 0 ? ` · ${entry.omitted} omitted` : ""}
          <IconChevronRight size={10} className="row-caret" />
        </span>
      </button>
      {open && <pre className="handoff-body">{entry.text}</pre>}
    </div>
  );
}

const FEATURED_AGENTS = ["claude-acp", "codex-acp", "gemini"];

function EmptyState({ onBrowse }: { onBrowse: () => void }): React.JSX.Element {
  const { agents, connection } = useStore();
  const installed = agents.filter((a) => a.installed);
  const registry = agents.filter((a) => a.source === "registry");
  const rank = (a: AgentDescriptor) => {
    const i = FEATURED_AGENTS.indexOf(a.id);
    return i < 0 ? FEATURED_AGENTS.length : i;
  };
  const suggested = [...registry].sort((a, b) => rank(a) - rank(b)).slice(0, 3);
  return (
    <div className="empty">
      <div className="empty-hero">
        <div className="empty-mark">
          <IconShipwreck size={40} />
        </div>
        <h2 className="empty-title">{installed.length ? "Choose an agent" : "Install an agent"}</h2>
        <p>
          {installed.length
            ? "Pick an agent to get started. Each one runs locally over the Agent Client Protocol."
            : "Agents run on your machine and talk to the editor over the Agent Client Protocol. Install one to start."}
        </p>
      </div>
      {!installed.length && suggested.length > 0 && (
        <div className="empty-suggest">
          {suggested.map((a) => (
            <AgentCard key={a.id} agent={a} />
          ))}
        </div>
      )}
      {installed.length > 0 && (
        <div className="empty-list" role="list">
          {installed.map((a) => (
            <button
              key={a.id}
              role="listitem"
              className="empty-agent"
              onClick={() => post({ type: "selectAgent", agentId: a.id })}
            >
              <span className="empty-agent-logo">
                <AgentLogo agent={a} size={16} />
              </span>
              <span className="empty-agent-name">{a.name}</span>
              {a.version && <span className="empty-agent-ver">{a.version}</span>}
              <IconChevronRight size={11} className="empty-agent-go" />
            </button>
          ))}
        </div>
      )}
      <button className="btn primary" onClick={onBrowse}>
        <IconPackage size={14} /> {installed.length ? "Browse agents" : "Browse all agents"}
      </button>
      {connection.status === "error" && connection.detail && (
        <div className="row-head notice error" role="alert">
          <span className="row-ic notice-ic">
            <IconWarning size={14} />
          </span>
          <div className="notice-text">
            <div className="notice-title">{connection.detail}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConnBanner(): React.JSX.Element | null {
  const { connection, agents, activeAgentId, authMethods } = useStore();
  const active = agents.find((a) => a.id === activeAgentId);
  if (connection.status === "auth_required" && authMethods.length) {
    return (
      <div className="panel auth-card">
        <div className="panel-title">
          <IconKey size={14} className="elic-ic" />
          <span>Sign in to {active?.name ?? "the agent"}</span>
        </div>
        <div className="panel-actions">
          {authMethods.map((m, i) => (
            <button
              key={m.id}
              className={`btn small${i === 0 ? " primary" : ""}`}
              onClick={() => post({ type: "authenticate", methodId: m.id })}
              title={m.description ?? undefined}
            >
              {m.name}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (connection.status === "error") {
    return (
      <div className="panel conn-error" role="alert">
        <IconWarning size={14} className="conn-error-ic" />
        <div className="conn-error-text">
          <div>{active?.name ?? "The agent"} couldn't start</div>
          {connection.detail && <div className="conn-error-detail truncate">{connection.detail}</div>}
        </div>
        <button
          className="btn small"
          onClick={() => activeAgentId && post({ type: "selectAgent", agentId: activeAgentId })}
        >
          Retry
        </button>
      </div>
    );
  }
  return null;
}

/** Shown while a turn runs but nothing on screen is visibly progressing. */
function needsWorkingRow(entries: ChatEntry[]): boolean {
  const last = entries[entries.length - 1];
  if (!last) return true;
  if ((last.kind === "agent" || last.kind === "thought") && last.streaming) return false;
  if (last.kind === "tool" && (last.tool.status === "in_progress" || last.tool.status === "pending"))
    return false;
  if ((last.kind === "permission" || last.kind === "elicitation") && last.state === "pending")
    return false;
  return true;
}

function agentNameOf(agents: AgentDescriptor[], id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id;
}

export default function App(): React.JSX.Element {
  const {
    entries,
    activeAgentId,
    ready,
    agents,
    threads,
    activeThreadId,
    workspace,
    session,
    activity,
  } = useStore();
  const [view, setView] = useState<"chat" | "catalog" | "threads">("chat");
  const [showJump, setShowJump] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const openCatalog = useCallback(() => setView("catalog"), []);
  const openThreads = useCallback(() => setView("threads"), []);
  const closeView = useCallback(() => setView("chat"), []);
  const openFolderThreads = useCallback(() => {
    post({ type: "setThreadsScope", scope: "workspace" });
    setView("threads");
  }, []);

  useEffect(() => {
    const h = (e: Event) => {
      const type = (e as MessageEvent).data?.type;
      if (type === "openCatalog") setView("catalog");
      else if (type === "openHistory") setView("threads");
      else if (type === "closeView") setView("chat");
    };
    window.addEventListener("message", h);
    return () => window.removeEventListener("message", h);
  }, []);

  useEffect(() => post({ type: "route", view }), [view]);

  useEffect(() => {
    if (view === "chat") return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setView("chat");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [view]);

  const busy = !!session?.busy;
  const working = busy && entries.length > 0 && needsWorkingRow(entries);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, working, view]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stickRef.current = stick;
    if (stick === showJump) setShowJump(!stick);
  };

  const jumpToBottom = () => {
    const el = listRef.current;
    if (el) {
      stickRef.current = true;
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    }
  };

  const acts = useMemo(() => activityByThread(activity, activeThreadId), [activity, activeThreadId]);
  const ends = useMemo(() => turnEnds(entries, busy), [entries, busy]);

  if (view === "catalog") {
    return (
      <div className="app">
        <Catalog onClose={closeView} />
      </div>
    );
  }
  if (view === "threads") {
    return (
      <div className="app">
        <Threads onClose={closeView} />
      </div>
    );
  }

  const active = agents.find((a) => a.id === activeAgentId);
  const folder = workspace?.folders[0]?.path;
  const recentThreads = threads
    .filter((t) => !t.archived && (!folder || t.workspace === folder || t.source))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="app">
      <div className="messages" ref={listRef} onScroll={onScroll}>
        <ConnBanner />
        {ready && recentThreads.length > 0 && (
          <div className="recent">
            <div className="recent-head">Recent chats</div>
            {recentThreads.slice(0, 3).map((t) => (
              <ThreadRow
                key={t.id}
                meta={t}
                agents={agents}
                active={t.id === activeThreadId}
                activity={acts.get(t.id)}
                compact
                onOpen={() => post({ type: "openThread", threadId: t.id })}
              />
            ))}
            <button className="link-btn recent-all" onClick={openThreads}>
              View all ({recentThreads.length})
            </button>
          </div>
        )}
        {!ready ? (
          <div className="loading">Loading…</div>
        ) : !activeAgentId ? (
          <EmptyState onBrowse={openCatalog} />
        ) : entries.length === 0 ? (
          <div className="empty-session">
            {active && <AgentLogo agent={active} size={56} className="empty-logo" />}
          </div>
        ) : (
          entries.map((e) => {
            const end = ends.get(e.id);
            return (
              <EntryView
                key={e.id}
                entry={e}
                live={busy && e.kind === "agent" && !!e.streaming}
                agentName={e.kind === "handoff" ? agentNameOf(agents, e.toAgentId) : undefined}
                endTs={end?.ts}
                endLast={end?.last}
              />
            );
          })
        )}
        {working && (
          <div className="working" role="status">
            <span className="working-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Working
          </div>
        )}
        {showJump && (
          <button className="jump-bottom" onClick={jumpToBottom} title="Jump to latest" aria-label="Jump to latest">
            <IconArrowDown size={14} />
          </button>
        )}
      </div>
      <EditsBar entries={entries} />
      <Composer onBrowse={openCatalog} onHistory={openThreads} onThreads={openFolderThreads} />
    </div>
  );
}
