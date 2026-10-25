import type { AgentDescriptor, AgentModels, ConfigOptionInfo, SessionMeta } from "../src/types";
import { getComposerConfig } from "./configOptions";

export interface PickerModel {
  value: string;
  name: string;
  description?: string | null;
  group?: string;
  /** Live options carry a groupId, so two groups may share a label. */
  groupKey?: string;
}

/** One installed agent as the model picker shows it. */
export interface PickerAgent {
  agent: AgentDescriptor;
  status: AgentModels["status"] | "unknown";
  models: PickerModel[];
  current?: string;
  /** False when the agent offers no model choice: the picker offers "Use <agent>". */
  hasChoice: boolean;
  message?: string;
}

export interface Favorite {
  agentId: string;
  value: string;
}

export const FAVORITES_PREF = "modelFavorites";

export function favKey(agentId: string, value: string): string {
  return `${agentId}\u0000${value}`;
}

export function liveModelOption(
  session: SessionMeta | null,
  activeAgentId: string | undefined,
): ConfigOptionInfo | undefined {
  if (!session || !activeAgentId || session.agentId !== activeAgentId) return undefined;
  return getComposerConfig(session.configOptions ?? [], false).primaryModel;
}

export function buildPickerAgents(
  agents: readonly AgentDescriptor[],
  catalog: readonly AgentModels[],
  session: SessionMeta | null,
  activeAgentId: string | undefined,
): PickerAgent[] {
  const byId = new Map(catalog.map((c) => [c.agentId, c]));
  const live = liveModelOption(session, activeAgentId);
  return agents
    .filter((a) => a.installed)
    .map((agent): PickerAgent => {
      if (agent.id === activeAgentId && live?.options?.length) {
        return {
          agent,
          status: "ready",
          models: live.options.map((o) => ({
            value: String(o.value),
            name: o.name,
            description: o.description,
            group: o.group,
            groupKey: o.groupId ?? o.group,
          })),
          current: String(live.currentValue),
          hasChoice: true,
        };
      }
      const c = byId.get(agent.id);
      if (!c) return { agent, status: "unknown", models: [], hasChoice: false };
      return {
        agent,
        status: c.status,
        models: c.models.map((m) => ({ ...m, groupKey: m.group })),
        current: c.currentValue ?? c.preferredValue,
        hasChoice: !!c.configId && c.models.length > 0,
        message: c.message,
      };
    });
}

/** Trigger label: live model, then the catalog's current/preferred, then the agent. */
export function currentModelName(pa: PickerAgent | undefined): string | undefined {
  if (!pa || pa.current === undefined) return undefined;
  return pa.models.find((m) => m.value === pa.current)?.name;
}

const norm = (s?: string | null): string => (s ?? "").toLowerCase();
const WORD_SPLIT = /[\s\-_./:()[\]]+/;

function score(q: string, tokens: string[], name: string, others: string): number | null {
  const n = norm(name);
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  const words = n.split(WORD_SPLIT);
  if (tokens.every((t) => words.some((w) => w.startsWith(t)))) return 2;
  if (tokens.every((t) => n.includes(t))) return 3;
  const all = `${n} ${others}`;
  if (tokens.every((t) => all.includes(t))) return 4;
  return null;
}

export interface SearchGroup {
  pa: PickerAgent;
  /** A single undefined entry represents an agent without a model choice. */
  hits: (PickerModel | undefined)[];
}

export function searchModels(list: readonly PickerAgent[], query: string): SearchGroup[] {
  const q = query.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const groups: { g: SearchGroup; best: number; order: number }[] = [];
  list.forEach((pa, order) => {
    const agentName = norm(pa.agent.name);
    if (!pa.hasChoice) {
      if (pa.status !== "ready" && pa.status !== "unknown") return;
      const s = score(q, tokens, pa.agent.name, "");
      if (s !== null) groups.push({ g: { pa, hits: [undefined] }, best: s, order });
      return;
    }
    const scored: { m: PickerModel; s: number; i: number }[] = [];
    pa.models.forEach((m, i) => {
      const s = score(q, tokens, m.name, `${norm(m.description)} ${norm(m.group)} ${agentName}`);
      if (s !== null) scored.push({ m, s, i });
    });
    if (!scored.length) return;
    scored.sort((a, b) => a.s - b.s || a.i - b.i);
    groups.push({ g: { pa, hits: scored.map((x) => x.m) }, best: scored[0].s, order });
  });
  groups.sort((a, b) => a.best - b.best || a.order - b.order);
  return groups.map((x) => x.g);
}
