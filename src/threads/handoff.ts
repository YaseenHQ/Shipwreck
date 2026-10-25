import type { ChatEntry, Part } from "../types";
import { diffHunks, diffStats } from "../diffstats";

export const HANDOFF_BUDGET_BYTES = 64_000;

export interface HandoffResult {
  text: string;
  included: number;
  omitted: number;
  agents: string[];
}

interface Item {
  kind: "user" | "agent" | "tool" | "plan";
  header: string;
  lines: string[];
  agentId?: string;
}

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;

function textParts(parts: Part[] | undefined): string {
  return (parts ?? [])
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join("/");
}

function itemize(
  entries: ChatEntry[],
  agentName: (id: string) => string,
): Item[] {
  const items: Item[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case "user": {
        const text = textParts(e.parts);
        if (text) items.push({ kind: "user", header: "User", lines: [text] });
        break;
      }
      case "agent": {
        const text = textParts(e.parts);
        if (!text) break;
        const name = e.agentId ? agentName(e.agentId) : "Assistant";
        items.push({ kind: "agent", header: name, lines: [text], agentId: e.agentId });
        break;
      }
      case "tool": {
        const t = e.tool;
        let line = `- ${t.kind ?? "tool"} ${t.title ?? t.name ?? ""}`.trimEnd();
        const loc = t.locations?.[0]?.path;
        if (loc) line += ` ${shortPath(loc)}`;
        const diff = t.content?.find((c) => c.type === "diff");
        if (diff && diff.type === "diff") {
          const s = diffStats(diffHunks(diff.oldText, diff.newText));
          line += ` (+${s.add} −${s.del})`;
        }
        line += ` → ${t.status ?? "done"}`;
        // Fold into the previous agent/tools section when consecutive.
        const prev = items[items.length - 1];
        if (prev && (prev.kind === "agent" || prev.kind === "tool")) {
          prev.lines.push(line);
        } else {
          items.push({ kind: "tool", header: "Tools", lines: [line], agentId: e.agentId });
        }
        break;
      }
      case "plan": {
        items.push({
          kind: "plan",
          header: "Plan",
          lines: e.entries.map(
            (p) => `- [${p.status ?? "pending"}] ${p.content}`,
          ),
          agentId: e.agentId,
        });
        break;
      }
      default:
        break; // thoughts, permissions, elicitations, notices, markers, handoffs
    }
  }
  return items;
}

function fmt(i: Item): string {
  return `### ${i.header}\n${i.lines.join("\n")}`;
}

function render(
  items: Item[],
  kept: { item: Item; text: string }[],
  omitted: number,
  agentName: (id: string) => string,
): string {
  const names = [
    ...new Set(
      items
        .map((i) => i.agentId)
        .filter((x): x is string => !!x)
        .map(agentName),
    ),
  ];
  const withClause = names.length ? ` (with ${names.join(", ")})` : "";
  const parts = [
    `Context from earlier in this thread${withClause}. This is background — the user's new request follows after it.`,
  ];
  for (let k = 0; k < kept.length; k++) {
    // Insert the omission marker before the first kept item that follows a gap.
    if (k === 1 && omitted > 0) {
      parts.push(
        `[… ${omitted} earlier item${omitted === 1 ? "" : "s"} omitted — the full transcript is attached]`,
      );
    }
    parts.push(kept[k].text);
  }
  return parts.join("\n\n");
}

/** Build the budgeted handoff block for `entries`, or null when nothing is eligible. */
export function buildHandoff(
  entries: ChatEntry[],
  opts: {
    budgetBytes: number;
    agentName: (id: string) => string;
    currentAgentId: string;
  },
): HandoffResult | null {
  const items = itemize(entries, opts.agentName);
  if (!items.length) return null;

  const kept: { item: Item; text: string }[] = [];
  const keepIdx = new Set<number>();
  let used = 0;

  // The first user message is always kept.
  const firstUser = items.findIndex((i) => i.kind === "user");
  if (firstUser >= 0) {
    keepIdx.add(firstUser);
    used += bytes(fmt(items[firstUser]));
  }

  // Walk backward from the newest, taking whole items that fit.
  let suffixAdded = 0;
  let truncated: { idx: number; text: string } | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    if (keepIdx.has(i)) continue;
    const text = fmt(items[i]);
    const b = bytes(text);
    if (used + b <= opts.budgetBytes) {
      keepIdx.add(i);
      used += b;
      if (i > firstUser) suffixAdded++;
    } else if (i === items.length - 1 && suffixAdded === 0) {
      // The newest item alone exceeds the budget — keep a truncated half.
      const half = Math.floor(opts.budgetBytes / 2);
      let cut = text;
      while (bytes(cut) > half && cut.length > 0) cut = cut.slice(0, -256);
      truncated = {
        idx: i,
        text: `${cut}\n… [truncated — see transcript]`,
      };
      keepIdx.add(i);
      break;
    }
  }

  const keptItems = [...keepIdx].sort((a, b) => a - b);
  for (const i of keptItems) {
    kept.push({ item: items[i], text: truncated?.idx === i ? truncated.text : fmt(items[i]) });
  }
  const omitted = items.length - kept.length;
  const agents = [
    ...new Set(items.map((i) => i.agentId).filter((x): x is string => !!x)),
  ];
  return {
    text: render(items, kept, omitted, opts.agentName),
    included: kept.length,
    omitted,
    agents,
  };
}

/** The full transcript — every eligible item, no budget, same format. */
export function buildTranscript(
  entries: ChatEntry[],
  agentName: (id: string) => string,
): string {
  const items = itemize(entries, agentName);
  return items.map(fmt).join("\n\n");
}
