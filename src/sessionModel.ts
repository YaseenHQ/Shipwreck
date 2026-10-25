import type * as acp from "@agentclientprotocol/sdk";
import {
  ChatEntry,
  ConfigOptionInfo,
  Part,
  PlanItem,
  SessionMeta,
  ToolCallContentState,
  ToolCallState,
} from "./types";
import type { ShipwreckUpdate } from "./acp/v2/project";

let counter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${counter++}`;
}

function contentBlockToPart(block: acp.ContentBlock): Part {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", data: block.data, mimeType: block.mimeType };
    case "audio":
      return { type: "audio", data: block.data, mimeType: block.mimeType };
    case "resource_link":
      return {
        type: "resource_link",
        uri: block.uri,
        name: block.name,
        mimeType: block.mimeType ?? undefined,
      };
    case "resource": {
      const res = block.resource;
      return {
        type: "resource",
        uri: res.uri,
        text: "text" in res ? res.text : undefined,
        mimeType: res.mimeType ?? undefined,
      };
    }
    default:
      return { type: "text", text: `[unsupported content: ${(block as { type: string }).type}]` };
  }
}

function toolCallContent(c: acp.ToolCallContent): ToolCallContentState {
  if (c.type === "content") {
    return { type: "content", content: contentBlockToPart(c.content) };
  }
  if (c.type === "diff") {
    return { type: "diff", path: c.path, oldText: c.oldText, newText: c.newText };
  }
  return { type: "terminal", terminalId: (c as acp.Terminal & { type: "terminal" }).terminalId };
}

function toolCallState(t: acp.ToolCall | acp.ToolCallUpdate): ToolCallState {
  const tc = t as acp.ToolCall;
  return {
    toolCallId: t.toolCallId,
    title: tc.title ?? undefined,
    name: tc.name ?? undefined,
    kind: tc.kind ?? undefined,
    status: tc.status ?? undefined,
    content: Array.isArray(tc.content) ? tc.content.map(toolCallContent) : undefined,
    locations: tc.locations ?? undefined,
    rawInput: tc.rawInput,
    rawOutput: tc.rawOutput,
  };
}

/**
 * Reduces `session/update` notifications into a normalized list of chat
 * entries that the webview renders. Also extracts session-level metadata
 * (modes, config options, commands, usage) via `applyMeta`.
 */
export class SessionModel {
  entries: ChatEntry[] = [];
  private streaming: Partial<
    Record<"agent" | "thought" | "user", { id: string; messageId?: string | null }>
  > = {};
  /** Streamed entries finalized since applyUpdate last ran — reported as changed. */
  private closedSince: ChatEntry[] = [];
  private toolEntries = new Map<string, string>();
  private planEntries = new Map<string, string>();
  private compactionEntries = new Map<string, string>();
  private messageEntries = new Map<string, string>();
  /** Set when a prompt was sent locally, so echoed user chunks aren't duplicated. */
  suppressUserEcho = false;
  /** Text the last applyUpdate appended to an existing part, if that was all it did. */
  private appended: { entryId: string; partIndex: number; text: string } | undefined;

  reset(): void {
    this.entries = [];
    this.streaming = {};
    this.toolEntries.clear();
    this.planEntries.clear();
    this.compactionEntries.clear();
    this.messageEntries.clear();
    this.suppressUserEcho = false;
  }

  private upsert(entry: ChatEntry): ChatEntry {
    const idx = this.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) this.entries[idx] = entry;
    else {
      // A new non-streamed entry interrupts any open message stream so later
      // chunks start a fresh entry below it.
      this.closeAllStreams();
      this.entries.push(entry);
    }
    return entry;
  }

  private byId(id: string): ChatEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  private closeStreaming(kind: "agent" | "thought" | "user"): void {
    const cur = this.streaming[kind];
    if (!cur) return;
    const e = this.byId(cur.id);
    if (e && (e.kind === "agent" || e.kind === "thought") && e.streaming) {
      e.streaming = false;
      this.closedSince.push(e);
    }
    delete this.streaming[kind];
  }

  private closeAllStreams(): void {
    this.closeStreaming("agent");
    this.closeStreaming("thought");
    this.closeStreaming("user");
  }

  /** Entries closed outside applyUpdate — callers should push them as upserts. */
  drainClosed(): ChatEntry[] {
    const c = this.closedSince;
    this.closedSince = [];
    return c;
  }

  /** Insert a non-streamed entry (handoff, marker), closing open streams. */
  insertEntry(entry: ChatEntry): ChatEntry {
    this.closeAllStreams();
    this.entries.push(entry);
    return entry;
  }

  private streamEntry(
    kind: "agent" | "thought" | "user",
    content: acp.ContentBlock,
    messageId?: string | null,
  ): ChatEntry {
    const part = contentBlockToPart(content);
    const cur = this.streaming[kind];
    // Same stream when ids match, or when either side carries no messageId.
    const sameMessage =
      !!cur &&
      (cur.messageId == null || messageId == null || cur.messageId === messageId);
    const existing = sameMessage && cur ? this.byId(cur.id) : undefined;
    if (existing && (existing.kind === "agent" || existing.kind === "thought" || existing.kind === "user")) {
      if (messageId != null && cur) cur.messageId = messageId;
      const last = existing.parts[existing.parts.length - 1];
      if (part.type === "text" && last?.type === "text") {
        last.text += part.text;
        this.appended = {
          entryId: existing.id,
          partIndex: existing.parts.length - 1,
          text: part.text,
        };
      } else {
        existing.parts.push(part);
      }
      return existing;
    }
    this.closeAllStreams();
    const entry: ChatEntry =
      kind === "user"
        ? { id: nextId("u"), kind: "user", ts: Date.now(), parts: [part] }
        : { id: nextId(kind === "agent" ? "a" : "t"), kind, ts: Date.now(), parts: [part], streaming: true };
    this.streaming[kind] = { id: entry.id, messageId: messageId ?? null };
    if (messageId != null) this.messageEntries.set(messageId, entry.id);
    this.entries.push(entry);
    return entry;
  }

  private replaceMessage(
    kind: "agent" | "thought" | "user",
    messageId: string,
    content: acp.ContentBlock[] | null,
  ): ChatEntry {
    const parts = (content ?? []).map(contentBlockToPart);
    const id = this.messageEntries.get(messageId);
    const existing = id ? this.byId(id) : undefined;
    if (existing && (existing.kind === "agent" || existing.kind === "thought" || existing.kind === "user")) {
      existing.parts = parts;
      return existing;
    }
    this.closeAllStreams();
    const entry: ChatEntry =
      kind === "user"
        ? { id: nextId("u"), kind: "user", ts: Date.now(), parts }
        : { id: nextId(kind === "agent" ? "a" : "t"), kind, ts: Date.now(), parts, streaming: true };
    this.streaming[kind] = { id: entry.id, messageId };
    this.messageEntries.set(messageId, entry.id);
    this.entries.push(entry);
    return entry;
  }

  addLocalUserMessage(parts: Part[]): ChatEntry {
    // A new user turn closes whatever was streaming (agent reply, thought).
    this.closeAllStreams();
    const entry: ChatEntry = {
      id: nextId("u"),
      kind: "user",
      ts: Date.now(),
      parts,
      local: true,
    };
    this.entries.push(entry);
    this.suppressUserEcho = true;
    return entry;
  }

  /** Called when a prompt turn finishes (any stop reason) — streaming ends. */
  endTurn(): ChatEntry[] {
    const changed: ChatEntry[] = [];
    for (const key of Object.keys(this.streaming) as ("agent" | "thought" | "user")[]) {
      const cur = this.streaming[key];
      if (!cur) continue;
      const e = this.byId(cur.id);
      if (e && (e.kind === "agent" || e.kind === "thought")) {
        e.streaming = false;
        changed.push(e);
      }
    }
    this.streaming = {};
    this.suppressUserEcho = false;
    return changed;
  }

  /**
   * Apply a `session/update` notification. Returns entries that were created
   * or modified (for granular pushes) plus any session-meta patch.
   */
  applyUpdate(
    notification: acp.SessionNotification,
    meta: SessionMeta,
  ): {
    changed: ChatEntry[];
    /** Set when a changed entry only grew by this text — send it as a delta. */
    appended?: { entryId: string; partIndex: number; text: string };
  } {
    const update = notification.update as acp.SessionUpdate & Record<string, unknown>;
    const changed: ChatEntry[] = [];
    const kind = update.sessionUpdate;
    this.closedSince = [];
    this.appended = undefined;
    const messageId = (update as { messageId?: string | null }).messageId;

    switch (kind as string) {
      case "_shipwreck_message_replace": {
        const m = update as unknown as Extract<ShipwreckUpdate, { sessionUpdate: "_shipwreck_message_replace" }>;
        if (m.role === "user" && this.suppressUserEcho) break;
        changed.push(this.replaceMessage(m.role, m.messageId, m.content));
        break;
      }
      case "_shipwreck_unclaimed_turn_end": {
        const t = update as unknown as Extract<ShipwreckUpdate, { sessionUpdate: "_shipwreck_unclaimed_turn_end" }>;
        this.closeAllStreams();
        if (t.stopReason === "error") {
          changed.push(
            this.upsert({
              id: nextId("notice"),
              kind: "notice",
              ts: Date.now(),
              severity: "error",
              title: t.error?.message ?? "The agent reported an error",
            }),
          );
        }
        break;
      }
      case "user_message_chunk": {
        if (this.suppressUserEcho) break;
        const e = this.streamEntry("user", update.content as acp.ContentBlock, messageId);
        changed.push(e);
        break;
      }
      case "agent_message_chunk": {
        const e = this.streamEntry("agent", update.content as acp.ContentBlock, messageId);
        changed.push(e);
        break;
      }
      case "agent_thought_chunk": {
        const e = this.streamEntry("thought", update.content as acp.ContentBlock, messageId);
        changed.push(e);
        break;
      }
      case "session_message":
      case "session_message_chunk": {
        // Inter-session message; render like agent output.
        const content = (update as { content?: acp.ContentBlock }).content;
        if (content) changed.push(this.streamEntry("agent", content, messageId));
        break;
      }
      case "tool_call": {
        const tool = toolCallState(update as unknown as acp.ToolCall);
        const existing = this.toolEntries.get(tool.toolCallId);
        const entry: ChatEntry = {
          id: existing ?? nextId("tool"),
          kind: "tool",
          ts: Date.now(),
          tool,
        };
        this.toolEntries.set(tool.toolCallId, entry.id);
        changed.push(this.upsert(entry));
        break;
      }
      case "tool_call_update": {
        const patch = update as unknown as acp.ToolCallUpdate;
        const entryId = this.toolEntries.get(patch.toolCallId);
        const existing = entryId ? this.byId(entryId) : undefined;
        if (existing && existing.kind === "tool") {
          const t = existing.tool;
          if (patch.title != null) t.title = patch.title;
          if (patch.name != null) t.name = patch.name;
          if (patch.kind != null) t.kind = patch.kind;
          if (patch.status != null) t.status = patch.status;
          if (patch.content != null) t.content = patch.content.map(toolCallContent);
          if (patch.locations != null) t.locations = patch.locations;
          if (patch.rawInput !== undefined) t.rawInput = patch.rawInput;
          if (patch.rawOutput !== undefined) t.rawOutput = patch.rawOutput;
          changed.push(existing);
        } else {
          // Update for an unseen tool call — create the entry.
          const tool = toolCallState(patch);
          const entry: ChatEntry = {
            id: nextId("tool"),
            kind: "tool",
            ts: Date.now(),
            tool,
          };
          this.toolEntries.set(patch.toolCallId, entry.id);
          changed.push(this.upsert(entry));
        }
        break;
      }
      case "plan": {
        const items = ((update as { entries?: acp.PlanEntry[] }).entries ?? []).map(
          (e): PlanItem => ({ content: e.content, priority: e.priority, status: e.status }),
        );
        const id = this.planEntries.get("default") ?? nextId("plan");
        this.planEntries.set("default", id);
        changed.push(this.upsert({ id, kind: "plan", ts: Date.now(), entries: items }));
        break;
      }
      case "plan_update": {
        const p = update as unknown as acp.PlanUpdate;
        const content = p.plan as {
          items?: acp.PlanEntry[];
          uri?: string;
          content?: string;
        };
        let items: PlanItem[] = [];
        if (Array.isArray(content?.items)) {
          items = content.items.map((e) => ({
            content: e.content,
            priority: e.priority,
            status: e.status,
          }));
        } else if (typeof content?.content === "string") {
          items = [{ content: content.content }];
        } else if (typeof content?.uri === "string") {
          items = [{ content: content.uri }];
        }
        const planId = (content as { planId?: string }).planId ?? "keyed";
        const id = this.planEntries.get(planId) ?? nextId("plan");
        this.planEntries.set(planId, id);
        changed.push(
          this.upsert({ id, kind: "plan", ts: Date.now(), planId, entries: items }),
        );
        break;
      }
      case "plan_removed": {
        const planId = (update as { planId?: string }).planId ?? "keyed";
        const id = this.planEntries.get(planId);
        if (id) {
          this.entries = this.entries.filter((e) => e.id !== id);
          this.planEntries.delete(planId);
        }
        break;
      }
      case "available_commands_update": {
        meta.availableCommands = (
          (update as { availableCommands?: acp.AvailableCommand[] }).availableCommands ?? []
        ).map((c) => ({
          name: c.name,
          description: c.description,
          inputHint:
            c.input && "hint" in (c.input as Record<string, unknown>)
              ? String((c.input as Record<string, unknown>).hint)
              : undefined,
        }));
        break;
      }
      case "current_mode_update": {
        if (meta.modes) {
          meta.modes.currentModeId = (update as { currentModeId: string }).currentModeId;
        }
        break;
      }
      case "config_option_update": {
        const cu = update as { configOptions?: acp.SessionConfigOption[] };
        meta.configOptions = toConfigOptionInfos(cu.configOptions ?? []);
        break;
      }
      case "session_info_update": {
        const info = update as { title?: string | null; updatedAt?: string | null };
        if (info.title !== undefined) meta.title = info.title;
        break;
      }
      case "usage_update": {
        const u = update as unknown as acp.UsageUpdate;
        meta.usage = {
          used: u.used,
          size: u.size,
          cost: u.cost ? { amount: u.cost.amount, currency: u.cost.currency } : null,
        };
        break;
      }
      case "notice": {
        const n = update as unknown as acp.Notice;
        changed.push(
          this.upsert({
            id: nextId("notice"),
            kind: "notice",
            ts: Date.now(),
            severity: n.severity,
            title: n.title,
            description: n.description,
          }),
        );
        break;
      }
      case "compaction_update": {
        const c = update as { compactionId?: string; status?: string; summary?: unknown };
        const cid = c.compactionId ?? "default";
        const id = this.compactionEntries.get(cid) ?? nextId("marker");
        this.compactionEntries.set(cid, id);
        const state = c.status ?? "in_progress";
        const existing = this.byId(id);
        changed.push(
          this.upsert({
            id,
            kind: "marker",
            ts: Date.now(),
            text:
              state === "completed"
                ? "Context compacted"
                : state === "failed"
                  ? "Context compaction failed"
                  : state === "cancelled"
                    ? "Context compaction cancelled"
                    : "Compacting context…",
            state,
            summary: existing?.kind === "marker" ? existing.summary : undefined,
          }),
        );
        break;
      }
      case "compaction_summary_chunk": {
        const c = update as { compactionId?: string; content?: acp.ContentBlock };
        const cid = c.compactionId ?? "default";
        const id = this.compactionEntries.get(cid) ?? nextId("marker");
        const existing = this.byId(id);
        const text =
          c.content && c.content.type === "text" ? c.content.text : undefined;
        if (text === undefined) break;
        this.compactionEntries.set(cid, id);
        if (existing && existing.kind === "marker") {
          existing.summary = (existing.summary ?? "") + text;
          changed.push(existing);
        } else {
          changed.push(this.upsert({
            id,
            kind: "marker",
            ts: Date.now(),
            text: "Compacting context…",
            state: "in_progress",
            summary: text,
          }));
        }
        break;
      }
      case "subagent_update": {
        const s = update as { sessionId?: string; title?: string | null };
        changed.push(
          this.upsert({
            id: nextId("notice"),
            kind: "notice",
            ts: Date.now(),
            severity: "info",
            title: `Subagent ${s.title ?? s.sessionId ?? ""}`.trim(),
          }),
        );
        break;
      }
      default:
        break;
    }
    for (const e of this.closedSince) {
      if (!changed.includes(e)) changed.push(e);
    }
    return { changed, appended: this.appended };
  }
}

export function toConfigOptionInfo(
  o: acp.SessionConfigOption,
): ConfigOptionInfo | undefined {
  const base = {
    id: o.id,
    name: o.name,
    description: o.description,
    category: o.category,
  };
  if (o.type === "boolean") {
    return { ...base, type: "boolean", currentValue: !!o.currentValue };
  }
  if (o.type !== "select") return undefined;
  const flat: ConfigOptionInfo["options"] = [];
  for (const opt of o.options ?? []) {
    if ("options" in opt) {
      for (const inner of opt.options) {
        flat.push({
          value: inner.value,
          name: inner.name,
          description: inner.description,
          group: opt.name,
          groupId: opt.group,
        });
      }
    } else {
      flat.push({ value: opt.value, name: opt.name, description: opt.description });
    }
  }
  return { ...base, type: "select", currentValue: o.currentValue, options: flat };
}

export function toConfigOptionInfos(
  options: readonly acp.SessionConfigOption[],
): ConfigOptionInfo[] {
  const out: ConfigOptionInfo[] = [];
  for (const o of options) {
    const info = toConfigOptionInfo(o);
    if (info) out.push(info);
  }
  return out;
}
