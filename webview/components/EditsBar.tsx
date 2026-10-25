import React, { useId, useMemo, useState } from "react";
import type { ChatEntry } from "../../src/types";
import { IconCheck, IconChevronDown, IconChevronRight, IconFile, IconOpenDiff, IconUndo } from "../icons";
import { post, useStore } from "../store";

interface OutstandingFile {
  path: string;
  add: number;
  del: number;
  entryIds: string[];
}

function Stats({ add, del }: { add: number; del: number }): React.JSX.Element {
  return <span className="edits-stats mono"><span>+{add}</span><span>−{del}</span></span>;
}

export function EditsBar({ entries }: { entries: ChatEntry[] }): React.JSX.Element | null {
  const { session, workspace } = useStore();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const files = useMemo(() => {
    const byPath = new Map<string, OutstandingFile>();
    const key = (p: string) => {
      const normalized = p.replace(/\\/g, "/");
      return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
    };
    for (const entry of entries) {
      if (entry.kind !== "changes") continue;
      const reverted = new Set((entry.reverted ?? []).map(key));
      for (const file of entry.files) {
        if (file.kept || reverted.has(key(file.path))) continue;
        const existing = byPath.get(key(file.path));
        if (existing) {
          existing.add += file.add;
          existing.del += file.del;
          if (!existing.entryIds.includes(entry.id)) existing.entryIds.push(entry.id);
        } else byPath.set(key(file.path), { path: file.path, add: file.add, del: file.del, entryIds: [entry.id] });
      }
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [entries]);
  if (!files.length) return null;
  const entryIds = [...new Set(files.flatMap((f) => f.entryIds))];
  const totals = files.reduce((sum, f) => ({ add: sum.add + f.add, del: sum.del + f.del }), { add: 0, del: 0 });
  const busy = session?.busy ?? false;
  const waiting = busy ? "Wait until the agent finishes editing." : undefined;

  return (
    <section className="edits-bar" aria-label="Unreviewed agent edits">
      <div className="edits-head">
        <button className="edits-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}>
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          <span>Edits</span><span className="edits-dot" aria-hidden="true">•</span>
          <span>{files.length} {files.length === 1 ? "file" : "files"}</span>
          <Stats {...totals} />
        </button>
        <div className="edits-actions">
          <button className="changes-btn" onClick={() => post({ type: "editsReview", entryIds })}><IconOpenDiff size={12} />Review</button>
          <button className="changes-btn" disabled={busy} title={waiting} onClick={() => post({ type: "editsUndo", entryIds })}><IconUndo size={12} />Undo All</button>
          <button className="changes-btn" disabled={busy} title={waiting} onClick={() => post({ type: "editsKeep", entryIds })}><IconCheck size={12} />Keep All</button>
        </div>
      </div>
      {expanded && (
        <ul className="edits-list" id={listId}>
          {files.map((file) => {
            const normalized = file.path.replace(/\\/g, "/");
            const cut = normalized.lastIndexOf("/");
            const name = normalized.slice(cut + 1);
            let dir = cut >= 0 ? normalized.slice(0, cut) : "";
            const root = workspace?.folders.find((f) => {
              const p = f.path.replace(/\\/g, "/").replace(/\/+$/, "");
              return dir.toLowerCase() === p.toLowerCase() || dir.toLowerCase().startsWith(p.toLowerCase() + "/");
            });
            if (root) {
              const relative = dir.slice(root.path.replace(/\\/g, "/").replace(/\/+$/, "").length).replace(/^\//, "");
              dir = (workspace?.folders.length ?? 0) > 1 ? [root.name, relative].filter(Boolean).join("/") : relative;
            }
            const message = { entryIds: file.entryIds, path: file.path };
            return (
              <li className="edits-row" key={file.path}>
                <button className="edits-file" title={file.path} onClick={() => post({ type: "editsReview", ...message })}>
                  <IconFile size={13} />
                  <span className="edits-label"><span>{name}</span>{dir && <span className="edits-dir">{dir}</span>}</span>
                  <Stats add={file.add} del={file.del} />
                </button>
                <div className="edits-row-actions">
                  <button className="changes-btn" aria-label={`Review changes to ${name}`} onClick={() => post({ type: "editsReview", ...message })}>Review</button>
                  <button className="changes-btn" disabled={busy} title={waiting} aria-label={`Undo changes to ${name}`} onClick={() => post({ type: "editsUndo", ...message })}>Undo</button>
                  <button className="changes-btn" disabled={busy} title={waiting} aria-label={`Keep changes to ${name}`} onClick={() => post({ type: "editsKeep", ...message })}>Keep</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
