import React, { memo, useMemo, useState } from "react";
import type { ChangedFile, ChatEntry, WorkspaceInfo } from "../../src/types";
import { post } from "../store";
import { useStoreSlice } from "../useStoreSlice";
import { IconFile, IconUndo } from "../icons";

type ChangesEntry = Extract<ChatEntry, { kind: "changes" }>;

const VISIBLE = 6;

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Basename plus its directory, relative to the workspace folder holding it. */
function splitPath(path: string, workspace?: WorkspaceInfo): { name: string; dir: string } {
  const p = norm(path);
  const cut = p.lastIndexOf("/");
  const name = cut >= 0 ? p.slice(cut + 1) : p;
  const parent = cut >= 0 ? p.slice(0, cut) : "";
  const folders = workspace?.folders ?? [];
  for (const f of folders) {
    const root = norm(f.path);
    const lowParent = parent.toLowerCase();
    const lowRoot = root.toLowerCase();
    if (lowParent === lowRoot || lowParent.startsWith(lowRoot + "/")) {
      const rel = parent.slice(root.length + 1);
      const dir = folders.length > 1 ? (rel ? `${f.name}/${rel}` : f.name) : rel;
      return { name, dir };
    }
  }
  return { name, dir: parent };
}

function Stats({ add, del }: { add: number; del: number }): React.JSX.Element {
  return (
    <span className="tool-diffstats mono changes-stats">
      <span className="diff-add">+{add}</span>
      <span className="diff-del">−{del}</span>
    </span>
  );
}

function ChangeRow({
  entryId,
  file,
  reverted,
  workspace,
}: {
  entryId: string;
  file: ChangedFile;
  reverted: boolean;
  workspace?: WorkspaceInfo;
}): React.JSX.Element {
  const { name, dir } = splitPath(file.path, workspace);
  return (
    <li className={`changes-row${reverted ? " reverted" : ""}`}>
      <button
        className="changes-file"
        title={file.path}
        onClick={() => post({ type: "reviewChanges", entryId, path: file.path })}
      >
        <span className="row-ic">
          <IconFile size={13} />
        </span>
        {/* One inline run, so the directory is cut before the name is. */}
        <span className="changes-label">
          <span className="changes-name">{name}</span>
          {dir && <span className="changes-dir">{dir}</span>}
        </span>
        {file.created && <span className="changes-badge">new</span>}
        <span className="row-fill" />
        {reverted || file.kept ? <span className="changes-undone">{reverted ? "Undone" : "Kept"}</span> : <Stats add={file.add} del={file.del} />}
      </button>
      {!reverted && !file.kept && (
        <button
          className="changes-undo"
          title="Undo changes"
          aria-label={`Undo changes to ${name}`}
          onClick={() => post({ type: "revertChanges", entryId, path: file.path })}
        >
          <IconUndo size={13} />
        </button>
      )}
    </li>
  );
}

export const ChangesCard = memo(function ChangesCard({
  entry,
}: {
  entry: ChangesEntry;
}): React.JSX.Element {
  const { workspace } = useStoreSlice((s) => ({ workspace: s.workspace }));
  const [all, setAll] = useState(false);
  const reverted = useMemo(() => new Set(entry.reverted ?? []), [entry.reverted]);
  const totals = useMemo(
    () =>
      entry.files.reduce(
        (t, f) => ({ add: t.add + f.add, del: t.del + f.del }),
        { add: 0, del: 0 },
      ),
    [entry.files],
  );
  const count = entry.files.length;
  const allReverted = entry.files.every((f) => reverted.has(f.path) || f.kept);
  const shown = all ? entry.files : entry.files.slice(0, VISIBLE);
  const title = `${count} ${count === 1 ? "file" : "files"} changed`;

  return (
    <div className="changes" role="group" aria-label={title}>
      <div className="changes-head">
        <span className="changes-title">{title}</span>
        <Stats add={totals.add} del={totals.del} />
        <span className="row-fill" />
        <button
          className="changes-btn"
          onClick={() => post({ type: "reviewChanges", entryId: entry.id })}
        >
          Review
        </button>
        {!allReverted && (
          <button
            className="changes-btn"
            onClick={() => post({ type: "revertChanges", entryId: entry.id })}
          >
            Undo
          </button>
        )}
      </div>
      <ul className="changes-list">
        {shown.map((f) => (
          <ChangeRow
            key={f.path}
            entryId={entry.id}
            file={f}
            reverted={reverted.has(f.path)}
            workspace={workspace}
          />
        ))}
      </ul>
      {count > VISIBLE && (
        <button className="changes-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show ${count - VISIBLE} more`}
        </button>
      )}
    </div>
  );
});
