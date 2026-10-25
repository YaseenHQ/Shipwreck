import React, { memo, useMemo, useState } from "react";
import type { ToolCallContentState, ToolCallState } from "../../src/types";
import { DiffView, diffHunks, diffStats } from "./DiffView";
import { PartView } from "./Parts";
import { post } from "../store";
import { useStoreSlice } from "../useStoreSlice";
import {
  IconChevronRight,
  IconEdit,
  IconFetch,
  IconFile,
  IconMove,
  IconOpenDiff,
  IconRead,
  IconSearch,
  IconSpinner,
  IconSwitch,
  IconTerminal,
  IconThink,
  IconTool,
  IconTrash,
  IconX,
} from "../icons";

export function kindIcon(kind?: string, size = 14): React.JSX.Element {
  switch (kind) {
    case "read":
      return <IconRead size={size} />;
    case "edit":
      return <IconEdit size={size} />;
    case "delete":
      return <IconTrash size={size} />;
    case "move":
      return <IconMove size={size} />;
    case "search":
      return <IconSearch size={size} />;
    case "execute":
      return <IconTerminal size={size} />;
    case "think":
      return <IconThink size={size} />;
    case "fetch":
      return <IconFetch size={size} />;
    case "switch_mode":
      return <IconSwitch size={size} />;
    default:
      return <IconTool size={size} />;
  }
}

function ToolStatus({ status }: { status?: string }): React.JSX.Element | null {
  switch (status) {
    case "completed":
      return null;
    case "failed":
      return (
        <span className="tool-status err">
          <IconX size={11} /> Failed
        </span>
      );
    case "in_progress":
      return <IconSpinner size={12} className="tool-status busy" />;
    default:
      return <IconSpinner size={12} className="tool-status pending" />;
  }
}

export function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
}

/** Agents often wrap commands in backticks; the row styles them instead. */
function cleanTitle(t: string): string {
  const m = /^`([^`]+)`$/.exec(t.trim());
  return m ? m[1] : t;
}

function commandOf(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { command?: unknown; args?: unknown; cmd?: unknown };
  const cmd = typeof r.command === "string" ? r.command : typeof r.cmd === "string" ? r.cmd : undefined;
  if (Array.isArray(r.command)) return r.command.map(String).join(" ");
  if (!cmd) return undefined;
  return Array.isArray(r.args) ? [cmd, ...r.args.map(String)].join(" ") : cmd;
}

function TerminalBlock({
  terminalId,
  output,
  truncated,
  exitStatus,
  command,
}: Extract<ToolCallContentState, { type: "terminal" }> & {
  command?: string;
}): React.JSX.Element {
  const { snapshot } = useStoreSlice((s) => ({ snapshot: s.terminals[terminalId] }));
  const [showAll, setShowAll] = useState(false);
  const text = (snapshot?.output ?? output ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-Z\\-_]/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const lines = text.replace(/\n$/, "").split("\n");
  const status = snapshot?.exitStatus ?? exitStatus;
  const didTruncate = snapshot?.truncated ?? truncated;
  return (
    <div className="term">
      <div className="term-head">
        <IconTerminal size={12} />
        <span>Terminal</span>
        {status && (
          <span className={`term-exit${status.exitCode !== 0 ? " err" : ""}`}>
            {status.signal ? `signal ${status.signal}` : `exit ${status.exitCode ?? "?"}`}
          </span>
        )}
        {snapshot?.live && <button
          className="term-open"
          title="Open terminal"
          onClick={() => post({ type: "revealTerminal", terminalId })}
        >
          Open terminal <IconOpenDiff size={11} />
        </button>}
      </div>
      {command && (
        <pre className="term-cmd">
          <span className="term-prompt" aria-hidden="true">
            $
          </span>
          {command}
        </pre>
      )}
      {text && (
        <pre className="term-output" tabIndex={0} aria-label="Terminal output">
          {(showAll ? lines : lines.slice(-12)).join("\n")}
        </pre>
      )}
      {(lines.length > 12 || didTruncate) && (
        <div className="term-foot">
          {didTruncate && <span>Earlier output omitted</span>}
          {lines.length > 12 && (
            <button className="term-toggle" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
              {showAll ? "Show less" : "Show all"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const ToolCallCard = memo(function ToolCallCard({
  tool,
}: {
  tool: ToolCallState;
}): React.JSX.Element {
  const content = useMemo(() => tool.content ?? [], [tool.content]);
  const hasBody =
    content.length > 0 ||
    (tool.locations?.length ?? 0) > 1 ||
    tool.rawInput !== undefined ||
    tool.rawOutput !== undefined;
  const diffs = useMemo(() => content.filter((c) => c.type === "diff"), [content]);
  // Diffs are the interesting payload — reveal them eagerly. Terminal
  // output and raw blobs stay collapsed.
  const [open, setOpen] = useState(diffs.length > 0);

  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const c of diffs) {
      if (c.type !== "diff") continue;
      const s = diffStats(diffHunks(c.oldText, c.newText));
      add += s.add;
      del += s.del;
    }
    return { add, del };
  }, [diffs]);

  const title = cleanTitle(tool.title ?? tool.name ?? "Tool call");
  const loc = tool.locations?.[0];
  const locText = loc ? shortPath(loc.path) : "";
  const locName = loc?.path.split(/[\\/]/).pop() ?? "";
  // The title often already names the file ("Read registry.ts").
  const showLoc = !!loc && !(locName && title.includes(locName));
  const command = tool.kind === "execute" ? commandOf(tool.rawInput) : undefined;
  const singleDiff = diffs.length === 1;

  const head = (
    <>
      <span className="row-ic tool-kind">{kindIcon(tool.kind)}</span>
      <span className={`tool-title${tool.kind === "execute" ? " mono" : ""}`}>{title}</span>
      {showLoc && (
        <span className="tool-loc mono" title={loc!.path}>
          {locText}
          {loc!.line != null ? `:${loc!.line}` : ""}
        </span>
      )}
      {stats.add + stats.del > 0 && (
        <span className="tool-diffstats mono">
          {stats.add > 0 && <span className="diff-add">+{stats.add}</span>}
          {stats.del > 0 && <span className="diff-del">−{stats.del}</span>}
        </span>
      )}
      <span className="row-fill" />
      <ToolStatus status={tool.status} />
      {hasBody && <IconChevronRight size={10} className="row-caret tool-caret" />}
    </>
  );

  return (
    <div className={`tool ${tool.status ?? ""}${open ? " open" : ""}`}>
      {hasBody ? (
        <button
          className="row-head tool-head"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={title}
        >
          {head}
        </button>
      ) : (
        <div className="row-head tool-head" title={title}>
          {head}
        </div>
      )}
      {open && hasBody && (
        <div className="row-body tool-body">
          {tool.locations && tool.locations.length > 1 && (
            <div className="tool-locs">
              {tool.locations.map((l, i) => (
                <button
                  key={i}
                  className="chip link"
                  onClick={() => post({ type: "openFile", path: l.path, line: l.line })}
                  title={l.path}
                >
                  <IconFile size={12} /> {shortPath(l.path)}
                  {l.line != null ? `:${l.line}` : ""}
                </button>
              ))}
            </div>
          )}
          {content.map((c, i) => {
            if (c.type === "diff") {
              return (
                <DiffView
                  key={i}
                  path={c.path}
                  oldText={c.oldText}
                  newText={c.newText}
                  bare={singleDiff}
                />
              );
            }
            if (c.type === "terminal") {
              return <TerminalBlock key={i} {...c} command={command} />;
            }
            return <PartView key={i} part={c.content} />;
          })}
          {tool.rawOutput !== undefined && <RawBlock label="Output" value={tool.rawOutput} />}
          {!content.length && tool.rawInput !== undefined && (
            <RawBlock label="Input" value={tool.rawInput} />
          )}
        </div>
      )}
    </div>
  );
});

function RawBlock({ label, value }: { label: string; value: unknown }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { preview, text } = useMemo(() => {
    try {
      return {
        preview: typeof value === "string" ? value : JSON.stringify(value),
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      };
    } catch {
      return { preview: String(value), text: String(value) };
    }
  }, [value]);
  if (!text?.trim()) return <></>;
  return (
    <div className={`raw${open ? " open" : ""}`}>
      <button className="raw-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <IconChevronRight size={10} className="row-caret" />
        <span className="raw-label">{label}</span>
        {!open && <span className="raw-preview mono">{preview}</span>}
      </button>
      {open && <pre className="raw-body">{text}</pre>}
    </div>
  );
}
