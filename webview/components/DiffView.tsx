import React, { useMemo, useState } from "react";
import { post } from "../store";
import { IconFile, IconOpenDiff } from "../icons";
import { diffHunks, diffStats } from "../../src/diffstats";

export { diffHunks, diffStats };
export type { DiffHunk } from "../../src/diffstats";

interface Props {
  path: string;
  oldText?: string | null;
  newText: string;
  bare?: boolean;
}

/* Long diffs render a prefix until asked; the full patch opens in the editor. */
const LINE_CAP = 240;

export function DiffView({ path, oldText, newText, bare }: Props): React.JSX.Element {
  const hunks = useMemo(() => diffHunks(oldText, newText), [oldText, newText]);
  const stats = useMemo(() => diffStats(hunks), [hunks]);
  const total = useMemo(() => hunks.reduce((n, h) => n + h.lines.length, 0), [hunks]);
  const [all, setAll] = useState(false);

  const name = path.split(/[\\/]/).pop() ?? path;
  const openDiff = () => post({ type: "openDiff", path, oldText, newText });

  let budget = all ? Infinity : LINE_CAP;
  const shown = hunks.map((h) => {
    const lines = h.lines.slice(0, Math.max(0, budget));
    budget -= lines.length;
    return { h, lines };
  });

  return (
    <div className={`diff${bare ? " bare" : ""}`}>
      {bare ? (
        <button className="diff-open" title="Open diff" aria-label="Open diff" onClick={openDiff}>
          <IconOpenDiff size={12} />
        </button>
      ) : (
        <div className="diff-head">
          <button
            className="diff-file"
            title={path}
            onClick={() => post({ type: "openFile", path })}
          >
            <IconFile size={12} /> {name}
          </button>
          <span className="diff-stats mono">
            <span className="diff-add">+{stats.add}</span>
            <span className="diff-del">−{stats.del}</span>
          </span>
          <button className="diff-head-btn" onClick={openDiff}>
            Open diff
          </button>
        </div>
      )}
      <div className="diff-body">
        {shown.map(({ h, lines }, i) =>
          lines.length === 0 ? null : (
            <div key={i} className="hunk">
              {hunks.length > 1 && (
                <div className="hunk-head">
                  @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
                </div>
              )}
              {lines.map((line, j) => {
                const cls = line.startsWith("+")
                  ? "add"
                  : line.startsWith("-")
                    ? "del"
                    : "ctx";
                return (
                  <div key={j} className={`diff-line ${cls}`}>
                    <span className="diff-sign">
                      {cls === "add" ? "+" : cls === "del" ? "−" : " "}
                    </span>
                    <span className="diff-text">{line.slice(1)}</span>
                  </div>
                );
              })}
            </div>
          ),
        )}
        {!hunks.length && <div className="diff-empty">No textual changes</div>}
      </div>
      {!all && total > LINE_CAP && (
        <button className="diff-more" onClick={() => setAll(true)}>
          Show {total - LINE_CAP} more lines
        </button>
      )}
    </div>
  );
}
