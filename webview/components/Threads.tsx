import React, { memo, useEffect, useMemo, useState } from "react";
import { post, useStore } from "../store";
import type { AgentDescriptor, ThreadMeta } from "../../src/types";
import { AgentLogo } from "./AgentLogo";
import { ActivityBadge, activityByThread, type ActivityState } from "./Activity";
import {
  IconArchive,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconEdit,
  IconPin,
  IconSearch,
  IconTrash,
  IconX,
} from "../icons";

export function relTime(ts: string | number): string {
  const diff = Date.now() - new Date(ts).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function folderName(p?: string): string {
  if (!p) return "No folder";
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

export function ThreadLogos({
  agents,
  meta,
}: {
  agents: AgentDescriptor[];
  meta: ThreadMeta;
}): React.JSX.Element {
  const shown = meta.agents.slice(0, 3);
  return (
    <span className="thread-logos">
      {shown.map((id) => {
        const a = agents.find((x) => x.id === id);
        return a ? (
          <AgentLogo key={id} agent={a} size={14} className="thread-logo" />
        ) : (
          <span key={id} className="thread-logo thread-logo-empty" />
        );
      })}
    </span>
  );
}

export const ThreadRow = memo(function ThreadRow({
  meta,
  agents,
  active,
  compact,
  activity,
  onOpen,
  renaming,
  onStartRename,
  onEndRename,
}: {
  meta: ThreadMeta;
  agents: AgentDescriptor[];
  active?: boolean;
  compact?: boolean;
  activity?: ActivityState;
  onOpen?: () => void;
  renaming?: boolean;
  onStartRename?: () => void;
  onEndRename?: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(meta.title);
  const title = meta.title.trim() || <span className="thread-untitled">Untitled chat</span>;
  return (
    <div
      className={`hist-item thread-item${active ? " active" : ""}${activity ? ` act-row-${activity}` : ""}`}
      onDoubleClick={onStartRename}
    >
      {renaming ? (
        <input
          className="thread-rename"
          autoFocus
          aria-label="Thread title"
          defaultValue={meta.title}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              post({ type: "renameThread", threadId: meta.id, title: draft });
              onEndRename?.();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              onEndRename?.();
            }
          }}
          onBlur={onEndRename}
        />
      ) : (
        <button
          className="hist-name btnlike thread-name"
          onClick={onOpen}
          onDoubleClick={onStartRename}
          title={meta.preview || meta.title}
        >
          <ThreadLogos agents={agents} meta={meta} />
          <span className="thread-title">{title}</span>
          {meta.pinned && !compact && <IconPin size={10} filled className="thread-pin" />}
        </button>
      )}
      {!renaming && (
        <span className="thread-meta">
          {activity && <ActivityBadge state={activity} label={activity !== "done"} />}
          {(!activity || activity === "done") && (
            <span className="thread-time">{relTime(meta.updatedAt)}</span>
          )}
        </span>
      )}
      {!compact && !renaming && (
        <span className="thread-actions">
          <button
            className="icon-btn ghost small"
            title={meta.pinned ? "Unpin" : "Pin"}
            aria-label={meta.pinned ? "Unpin" : "Pin"}
            onClick={() =>
              post({ type: "setThreadPinned", threadId: meta.id, pinned: !meta.pinned })
            }
          >
            <IconPin size={12} filled={meta.pinned} />
          </button>
          <button
            className="icon-btn ghost small"
            title="Rename"
            aria-label="Rename"
            onClick={onStartRename}
          >
            <IconEdit size={12} />
          </button>
          <button
            className="icon-btn ghost small"
            title={meta.archived ? "Unarchive" : "Archive"}
            aria-label={meta.archived ? "Unarchive" : "Archive"}
            onClick={() =>
              post({
                type: "setThreadArchived",
                threadId: meta.id,
                archived: !meta.archived,
              })
            }
          >
            <IconArchive size={12} />
          </button>
          <button
            className="icon-btn danger small"
            title="Delete thread"
            aria-label="Delete thread"
            onClick={() => post({ type: "deleteThread", threadId: meta.id })}
          >
            <IconTrash size={12} />
          </button>
        </span>
      )}
    </div>
  );
});

function isImported(threads: ThreadMeta[], agentId: string, sessionId: string): boolean {
  const imp = `imp:${agentId}:${sessionId}`;
  return threads.some(
    (t) => t.id === imp || t.backing.some((b) => b.agentId === agentId && b.sessionId === sessionId),
  );
}

export function Threads({ onClose }: { onClose: () => void }): React.JSX.Element {
  const {
    threads,
    activeThreadId,
    agents,
    activeAgentId,
    nativeSessions,
    canListSessions,
    threadsScope,
    threadsImport,
    workspace,
    activity,
  } = useStore();
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const acts = useMemo(() => activityByThread(activity, activeThreadId), [activity, activeThreadId]);

  useEffect(() => {
    if (threadsImport && canListSessions) {
      post({ type: "listNativeSessions", all: threadsScope === "all" });
    }
  }, [threadsImport, canListSessions, threadsScope, activeAgentId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = threads;
    if (threadsScope === "workspace" && workspace?.folders[0]?.path) {
      const folder = workspace.folders[0].path;
      list = list.filter((t) => t.workspace === folder || t.source);
    }
    if (q) {
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.preview ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [threads, threadsScope, workspace, query]);

  const pinned = filtered.filter((t) => t.pinned && !t.archived);
  const recent = filtered
    .filter((t) => !t.pinned && !t.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const archived = filtered
    .filter((t) => t.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const groups = useMemo(() => {
    if (threadsScope !== "all") return null;
    const by = new Map<string, ThreadMeta[]>();
    for (const t of recent) {
      const k = t.workspace ?? "";
      const arr = by.get(k) ?? [];
      arr.push(t);
      by.set(k, arr);
    }
    return [...by.entries()].sort((a, b) =>
      folderName(a[0]).localeCompare(folderName(b[0])),
    );
  }, [recent, threadsScope]);

  const open = (id: string) => {
    post({ type: "openThread", threadId: id });
    onClose();
  };

  const active = agents.find((a) => a.id === activeAgentId);
  const importable = nativeSessions.filter(
    (s) => activeAgentId && !isImported(threads, activeAgentId, s.sessionId),
  );

  const row = (t: ThreadMeta) => (
    <ThreadRow
      key={t.id}
      meta={t}
      agents={agents}
      active={t.id === activeThreadId}
      activity={acts.get(t.id)}
      renaming={renaming === t.id}
      onStartRename={() => setRenaming(t.id)}
      onEndRename={() => setRenaming(null)}
      onOpen={() => open(t.id)}
    />
  );

  return (
    <div className="history threads">
      <div className="catalog-top">
        <div className="catalog-title">
          <button className="icon-btn ghost" onClick={onClose} title="Back to chat" aria-label="Back to chat">
            <IconChevronLeft size={14} />
          </button>
          <span>Threads</span>
          <div className="thread-scope" role="radiogroup" aria-label="Scope">
            <button
              className={`seg ${threadsScope === "workspace" ? "on" : ""}`}
              role="radio"
              aria-checked={threadsScope === "workspace"}
              onClick={() => post({ type: "setThreadsScope", scope: "workspace" })}
            >
              This folder
            </button>
            <button
              className={`seg ${threadsScope === "all" ? "on" : ""}`}
              role="radio"
              aria-checked={threadsScope === "all"}
              onClick={() => post({ type: "setThreadsScope", scope: "all" })}
            >
              All
            </button>
          </div>
        </div>
        <div className="thread-search">
          <IconSearch size={13} className="search-ic" />
          <input
            aria-label="Search threads"
            placeholder="Search threads"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="chip-x" onClick={() => setQuery("")} title="Clear" aria-label="Clear search">
              <IconX size={11} />
            </button>
          )}
        </div>
      </div>
      <div className="hist-list">
        {pinned.length > 0 && (
          <div className="thread-sec">
            <div className="thread-sec-head">Pinned</div>
            {pinned.map(row)}
          </div>
        )}
        {groups ? (
          groups.map(([folder, list]) => (
            <div className="thread-sec" key={folder || "none"}>
              <div className="thread-sec-head" title={folder || undefined}>
                {folderName(folder)}
              </div>
              {list.map(row)}
            </div>
          ))
        ) : (
          recent.length > 0 && (
            <div className="thread-sec">
              <div className="thread-sec-head">Recent</div>
              {recent.map(row)}
            </div>
          )
        )}
        {archived.length > 0 && (
          <div className="thread-sec">
            <button
              className="thread-sec-head btnlike"
              onClick={() => setShowArchived(!showArchived)}
              aria-expanded={showArchived}
            >
              <IconChevronRight size={10} className={showArchived ? "chev-open" : ""} />
              Archived ({archived.length})
            </button>
            {showArchived && archived.map(row)}
          </div>
        )}
        {!filtered.length && (
          <div className="list-empty">{query.trim() ? "No threads match." : "No threads yet."}</div>
        )}

        {threadsImport && canListSessions && active && importable.length > 0 && (
          <div className="thread-sec">
            <div className="thread-sec-head">From {active.name}</div>
            {importable.map((s) => {
              const doImport = () =>
                post({
                  type: "importSession",
                  agentId: active.id,
                  sessionId: s.sessionId,
                  title: s.title ?? undefined,
                });
              return (
                <div key={s.sessionId} className="hist-item import-item">
                  <button
                    className="hist-name btnlike thread-name"
                    onClick={doImport}
                    title={s.cwd ?? undefined}
                  >
                    <span className="thread-logos">
                      <AgentLogo agent={active} size={14} className="thread-logo" />
                    </span>
                    <span className="thread-title">
                      {s.title?.trim() || <span className="thread-untitled">Untitled chat</span>}
                    </span>
                  </button>
                  <span className="thread-meta">
                    <span className="thread-time">{s.updatedAt ? relTime(s.updatedAt) : ""}</span>
                  </span>
                  <button className="import-btn" onClick={doImport} title="Import into Threads">
                    <IconDownload size={11} /> Import
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
