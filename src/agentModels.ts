import type * as vscode from "vscode";
import type { AgentModels, ConfigOptionInfo } from "./types";

/** A successful probe is trusted this long before the picker asks the agent again. */
export const MODELS_FRESH_MS = 15 * 60_000;
const STORE_KEY = "shipwreck.agentModels";

export function modelOption(options: ConfigOptionInfo[] | undefined): ConfigOptionInfo | undefined {
  return options?.find((o) => o.category === "model" && o.type === "select");
}

/** Last known model list per agent, kept across reloads for the model picker. */
export class ModelCatalog {
  private readonly byAgent = new Map<string, AgentModels>();

  constructor(
    private readonly state: vscode.Memento,
    private readonly onChange: () => void,
  ) {
    for (const saved of state.get<AgentModels[]>(STORE_KEY, [])) {
      // Nothing is probing in a fresh window; an entry that never got models is dropped.
      if (saved.status === "probing") {
        if (!saved.models.length) continue;
        saved.status = "ready";
        saved.checkedAt = 0;
      }
      this.byAgent.set(saved.agentId, saved);
    }
  }

  list(): AgentModels[] {
    return [...this.byAgent.values()];
  }

  get(agentId: string): AgentModels | undefined {
    return this.byAgent.get(agentId);
  }

  isFresh(agentId: string, now = Date.now()): boolean {
    const e = this.byAgent.get(agentId);
    return !!e && e.status === "ready" && now - e.checkedAt < MODELS_FRESH_MS;
  }

  /** A session's options. Sessions without a model option leave the list alone:
   *  resumed sessions don't always repeat their options. */
  noteOptions(agentId: string, options: ConfigOptionInfo[] | undefined): void {
    const opt = modelOption(options);
    if (!opt) return;
    this.set(agentId, {
      status: "ready",
      configId: opt.id,
      models: (opt.options ?? []).map((o) => ({
        value: o.value,
        name: o.name,
        ...(o.description ? { description: o.description } : {}),
        ...(o.group ? { group: o.group } : {}),
      })),
      currentValue: String(opt.currentValue),
      message: undefined,
    });
  }

  /** A brand-new session offered no model option: the agent has no model choice. */
  noteNoChoice(agentId: string): void {
    this.set(agentId, {
      status: "ready",
      configId: undefined,
      models: [],
      currentValue: undefined,
      message: undefined,
    });
  }

  setStatus(agentId: string, status: AgentModels["status"], message?: string): void {
    this.set(agentId, { status, message }, status === "probing" ? "keepTime" : "stamp");
  }

  setPreferred(agentId: string, value: string): void {
    this.set(agentId, { preferredValue: value }, "keepTime");
  }

  private set(
    agentId: string,
    patch: Partial<Omit<AgentModels, "agentId">>,
    time: "stamp" | "keepTime" = "stamp",
  ): void {
    const prev = this.byAgent.get(agentId);
    const next: AgentModels = {
      agentId,
      status: "probing",
      models: [],
      ...prev,
      ...patch,
      checkedAt: time === "stamp" ? Date.now() : (prev?.checkedAt ?? 0),
    };
    for (const k of Object.keys(next) as (keyof AgentModels)[]) {
      if (next[k] === undefined) delete next[k];
    }
    this.byAgent.set(agentId, next);
    const visible = (e?: AgentModels) => (e ? JSON.stringify({ ...e, checkedAt: 0 }) : "");
    const changed = visible(prev) !== visible(next);
    // Every session update re-confirms the list; only the age moved.
    if (changed || next.checkedAt - (prev?.checkedAt ?? 0) > 60_000) {
      void this.state.update(STORE_KEY, this.list());
    }
    if (changed) this.onChange();
  }
}
