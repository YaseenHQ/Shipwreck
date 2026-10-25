import type * as acp from "@agentclientprotocol/sdk";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2";

export type ShipwreckUpdate =
  | {
      sessionUpdate: "_shipwreck_message_replace";
      role: "user" | "agent" | "thought";
      messageId: string;
      content: acp.ContentBlock[] | null;
    }
  | {
      sessionUpdate: "_shipwreck_unclaimed_turn_end";
      stopReason: string;
      error?: { code: number; message: string };
    };

type ToolField = "name" | "title" | "kind" | "status" | "content" | "locations" | "rawInput" | "rawOutput";
const TOOL_FIELDS: ToolField[] = ["name", "title", "kind", "status", "content", "locations", "rawInput", "rawOutput"];

export type ResolvedTool = { toolCallId: string } & Partial<Record<ToolField, unknown>> & {
  content?: v2.ToolCallContent[];
};

export class ToolMirror {
  private readonly tools = new Map<string, ResolvedTool>();

  apply(u: v2.ToolCallUpdate): ResolvedTool {
    const t: ResolvedTool = { ...(this.tools.get(u.toolCallId) ?? { toolCallId: u.toolCallId }) };
    const patch = u as unknown as Record<ToolField, unknown>;
    for (const f of TOOL_FIELDS) {
      if (patch[f] === undefined) continue;
      if (patch[f] === null) delete t[f];
      else (t as Record<string, unknown>)[f] = patch[f];
    }
    this.tools.set(u.toolCallId, t);
    return t;
  }

  appendContent(toolCallId: string, c: v2.ToolCallContent): ResolvedTool {
    const prev = this.tools.get(toolCallId) ?? { toolCallId };
    const t: ResolvedTool = { ...prev, content: [...(prev.content ?? []), c] };
    this.tools.set(toolCallId, t);
    return t;
  }
}

export function toolCallUpdate(t: ResolvedTool, terminalId: (id: string) => string): acp.SessionUpdate {
  const { content, ...rest } = t;
  return {
    ...rest,
    sessionUpdate: "tool_call",
    content: (content ?? []).flatMap((c) => projectContent(c, terminalId)),
  } as unknown as acp.SessionUpdate;
}

function projectContent(c: v2.ToolCallContent, terminalId: (id: string) => string): acp.ToolCallContent[] {
  switch (c.type) {
    case "content":
      return [c as acp.ToolCallContent];
    case "terminal":
      return [{ type: "terminal", terminalId: terminalId((c as v2.Terminal).terminalId) }];
    case "diff":
      return projectDiff(c as v2.Diff);
    default:
      return [];
  }
}

interface Hunk {
  old: string[];
  new: string[];
  oldEol: boolean;
  newEol: boolean;
  remOld: number;
  remNew: number;
}

interface PatchFile {
  oldPath?: string;
  newPath?: string;
  hunks: Hunk[];
}

const stripPrefix = (p: string) => p.replace(/\t.*$/, "").replace(/^[ab]\//, "");
const joinLines = (lines: string[], eol: boolean) => (lines.length ? lines.join("\n") + (eol ? "\n" : "") : "");

/** Hunk bodies are consumed by their header's line counts: a removed "-- x"
 *  line reads "--- x", the same as a file header. */
export function parseGitPatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | undefined;
  let hunk: Hunk | undefined;
  let last: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (hunk && (hunk.remOld > 0 || hunk.remNew > 0) && /^[ +-]|^$/.test(line)) {
      // Some tools strip the space of an empty context line.
      last = line === "" ? " " : line[0];
      const body = line.slice(1);
      if (last !== "+") {
        hunk.old.push(body);
        hunk.oldEol = true;
        hunk.remOld--;
      }
      if (last !== "-") {
        hunk.new.push(body);
        hunk.newEol = true;
        hunk.remNew--;
      }
      continue;
    }
    if (line.startsWith("\\") && hunk) {
      if (last !== "+") hunk.oldEol = false;
      if (last !== "-") hunk.newEol = false;
      continue;
    }
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (header && file) {
      hunk = {
        old: [],
        new: [],
        oldEol: true,
        newEol: true,
        remOld: header[1] === undefined ? 1 : Number(header[1]),
        remNew: header[2] === undefined ? 1 : Number(header[2]),
      };
      file.hunks.push(hunk);
    } else if (line.startsWith("diff --git ")) {
      file = { hunks: [] };
      files.push(file);
      hunk = undefined;
    } else if (line.startsWith("--- ")) {
      if (!file || file.hunks.length) files.push((file = { hunks: [] }));
      hunk = undefined;
      const p = line.slice(4);
      if (p !== "/dev/null") file.oldPath = stripPrefix(p);
    } else if (line.startsWith("+++ ") && file) {
      const p = line.slice(4);
      if (p !== "/dev/null") file.newPath = stripPrefix(p);
    }
  }
  return files;
}
const norm = (p: string) => p.replace(/\\/g, "/");
const matches = (abs: string, rel: string | undefined) =>
  !!rel && (norm(abs) === norm(rel) || norm(abs).endsWith("/" + norm(rel)));

export function projectDiff(d: v2.Diff): acp.ToolCallContent[] {
  const files = d.patch?.text ? parseGitPatch(d.patch.text) : [];
  const out: acp.ToolCallContent[] = [];
  const listed: string[] = [];
  for (const change of d.changes ?? []) {
    const c = change as { operation: string; path?: string; oldPath?: string; fileType?: string | null };
    const path = c.path ?? "";
    const textual = !c.fileType || c.fileType === "text";
    const file = files.find((f) =>
      c.operation === "delete" ? matches(path, f.oldPath) : matches(path, f.newPath),
    );
    if (textual && file?.hunks.length && (c.operation === "add" || c.operation === "modify" || c.operation === "delete")) {
      for (const h of file.hunks) {
        out.push({
          type: "diff",
          path,
          oldText: c.operation === "add" ? null : joinLines(h.old, h.oldEol),
          newText: c.operation === "delete" ? "" : joinLines(h.new, h.newEol),
        });
      }
      continue;
    }
    listed.push(fileLine(c.operation, path, c.oldPath));
  }
  if (listed.length) out.push({ type: "content", content: { type: "text", text: listed.join("\n") } });
  return out;
}

function fileLine(op: string, path: string, oldPath?: string): string {
  switch (op) {
    case "add":
      return `Added ${path}`;
    case "delete":
      return `Deleted ${path}`;
    case "modify":
      return `Modified ${path}`;
    case "move":
      return `Moved ${oldPath} to ${path}`;
    case "copy":
      return `Copied ${oldPath} to ${path}`;
    default:
      return `Changed ${path}`;
  }
}

export function configOptions(options: readonly v2.SessionConfigOption[] | undefined): acp.SessionConfigOption[] | undefined {
  if (!options) return undefined;
  return options.map((o) => {
    const { configId, ...rest } = o as { configId: string; options?: unknown[] } & Record<string, unknown>;
    const choices = Array.isArray(rest.options)
      ? rest.options.map((g) => {
          const { groupId, ...group } = g as { groupId?: string } & Record<string, unknown>;
          return groupId === undefined ? g : { ...group, group: groupId };
        })
      : rest.options;
    return { ...rest, id: configId, ...(choices ? { options: choices } : {}) } as unknown as acp.SessionConfigOption;
  });
}

export type ProjectedUpdate = Exclude<
  v2.SessionUpdate,
  { sessionUpdate: "state_update" | "terminal_update" | "terminal_output_chunk" }
>;

export function project(
  u: ProjectedUpdate,
  tools: ToolMirror,
  terminalId: (id: string) => string,
): (acp.SessionUpdate | ShipwreckUpdate)[] {
  const kind = (u as { sessionUpdate: string }).sessionUpdate;
  switch (kind) {
    case "user_message":
    case "agent_message":
    case "agent_thought": {
      const m = u as v2.AgentMessage;
      const role = kind === "user_message" ? "user" : kind === "agent_message" ? "agent" : "thought";
      return [
        {
          sessionUpdate: "_shipwreck_message_replace",
          role,
          messageId: m.messageId,
          content: (m.content as acp.ContentBlock[] | null | undefined) ?? null,
        },
      ];
    }
    case "tool_call_update":
      return [toolCallUpdate(tools.apply(u as v2.ToolCallUpdate), terminalId)];
    case "tool_call_content_chunk": {
      const c = u as v2.ToolCallContentChunk;
      return [toolCallUpdate(tools.appendContent(c.toolCallId, c.content), terminalId)];
    }
    case "plan_update": {
      const plan = (u as v2.PlanUpdate).plan as { entries?: unknown } & Record<string, unknown>;
      return [{ ...u, plan: { ...plan, items: plan.entries } } as unknown as acp.SessionUpdate];
    }
    case "config_option_update":
      return [
        { ...u, configOptions: configOptions((u as v2.ConfigOptionUpdate).configOptions) } as acp.SessionUpdate,
      ];
    default:
      return kind.startsWith("_shipwreck_") ? [] : [u as acp.SessionUpdate];
  }
}
