import * as vscode from "vscode";
import type { AgentConnection } from "./connection";
import type { LaunchSpec } from "../installer";
import type { SessionMeta } from "../types";

/** The part of AgentConnection the pool and controller use. */
export type PooledConnection = Pick<
  AgentConnection,
  "connected" | "initResponse" | "spec" | "start" | "request" | "notify" | "stop"
>;

/** Inactive agents are stopped after this long without use. */
export const IDLE_TIMEOUT_MS = 15 * 60_000;
/** Most agent processes kept alive at once; the least recently used inactive one goes first. */
export const MAX_LIVE_AGENTS = 4;
const REAP_INTERVAL_MS = 60_000;

interface Entry {
  conn: PooledConnection;
  lastUsedAt: number;
  /** Sessions established on the current process, with their last known meta. */
  sessions: Map<string, SessionMeta | undefined>;
  lastCommands?: SessionMeta["availableCommands"];
}

const DISCONNECTED: PooledConnection = {
  connected: false,
  initResponse: undefined,
  spec: undefined,
  start: () => Promise.reject(new Error("No agent selected")),
  request: () => Promise.reject(new Error("Not connected to an agent")),
  notify: () => Promise.resolve(),
  stop: () => Promise.resolve(),
};

/**
 * Keeps one connection per agent alive across agent and thread switches, and
 * remembers which sessions each live process already holds so reopening one
 * needs no agent call. Idle reaping and eviction never touch the active agent
 * or one with a turn still running in the background.
 */
export class AgentPool implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private active: string | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private create: (agentId: string) => PooledConnection,
    private readonly limits = { idleMs: IDLE_TIMEOUT_MS, maxLive: MAX_LIVE_AGENTS },
    /** Agents still working in the background are never stopped. */
    private readonly keepAlive: (agentId: string) => boolean = () => false,
  ) {
    this.timer = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    this.timer.unref?.();
  }

  private entry(agentId: string): Entry {
    let e = this.entries.get(agentId);
    if (!e) {
      e = { conn: this.create(agentId), lastUsedAt: Date.now(), sessions: new Map() };
      this.entries.set(agentId, e);
    }
    return e;
  }

  connection(agentId: string | null | undefined): PooledConnection {
    return agentId ? this.entry(agentId).conn : DISCONNECTED;
  }

  setActive(agentId: string | null | undefined): void {
    const prev = this.active;
    this.active = agentId ?? undefined;
    const now = Date.now();
    // Idle time counts from when an agent stopped being active.
    for (const id of [prev, agentId]) {
      const e = id ? this.entries.get(id) : undefined;
      if (e) e.lastUsedAt = now;
    }
  }

  /** Start (or restart) the agent's process. Sessions on the old process are gone.
   *  A background start (probing) never stops other agents to make room. */
  start(agentId: string, spec: LaunchSpec, cwd?: string, mode: "foreground" | "background" = "foreground") {
    const e = this.entry(agentId);
    e.sessions.clear();
    e.lastUsedAt = Date.now();
    if (mode === "foreground") this.evictFor(agentId);
    return e.conn.start(spec, cwd);
  }

  /** Stop an inactive agent that has nothing running. */
  stop(agentId: string): void {
    const e = this.entries.get(agentId);
    if (!e || agentId === this.active || this.keepAlive(agentId)) return;
    this.stopEntry(e);
  }

  retain(installed: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      if (installed.has(id)) continue;
      this.entries.delete(id);
      this.stopEntry(entry);
    }
  }

  withinLimit(): boolean {
    return this.liveAgents().length <= this.limits.maxLive;
  }

  /** The agent's current process holds this session. */
  holds(agentId: string, sessionId: string): boolean {
    const e = this.entries.get(agentId);
    return !!e?.conn.connected && e.sessions.has(sessionId);
  }

  markAttached(agentId: string, sessionId: string): void {
    const e = this.entry(agentId);
    if (!e.sessions.has(sessionId)) e.sessions.set(sessionId, undefined);
  }

  /** Record the latest meta for a session the process already holds. */
  remember(meta: SessionMeta): void {
    const e = this.entries.get(meta.agentId);
    if (!e) return;
    if (meta.availableCommands?.length) e.lastCommands = meta.availableCommands;
    if (e.sessions.has(meta.sessionId)) e.sessions.set(meta.sessionId, meta);
  }

  /** Meta of a session that is live on the agent's current process. */
  attached(agentId: string, sessionId: string): SessionMeta | undefined {
    const e = this.entries.get(agentId);
    return e?.conn.connected ? e.sessions.get(sessionId) : undefined;
  }

  detach(agentId: string, sessionId: string): void {
    this.entries.get(agentId)?.sessions.delete(sessionId);
  }

  lastCommands(agentId: string): SessionMeta["availableCommands"] {
    return this.entries.get(agentId)?.lastCommands;
  }

  /** The agent's sessions are gone (process exit) or can't be trusted (re-authentication). */
  forgetSessions(agentId: string): void {
    this.entries.get(agentId)?.sessions.clear();
  }

  forgetAllSessions(): void {
    for (const e of this.entries.values()) e.sessions.clear();
  }

  liveAgents(): string[] {
    return [...this.entries].filter(([, e]) => e.conn.connected).map(([id]) => id);
  }

  private stopEntry(e: Entry): void {
    e.sessions.clear();
    void e.conn.stop();
  }

  private evictFor(agentId: string): void {
    const live = [...this.entries].filter(
      ([id, e]) => id !== agentId && e.conn.connected,
    );
    const excess = live.length + 1 - this.limits.maxLive;
    if (excess <= 0) return;
    live
      .filter(([id]) => id !== this.active && !this.keepAlive(id))
      .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
      .slice(0, excess)
      .forEach(([, e]) => this.stopEntry(e));
  }

  reap(now = Date.now()): void {
    for (const [id, e] of this.entries) {
      if (id === this.active || !e.conn.connected || this.keepAlive(id)) continue;
      if (now - e.lastUsedAt >= this.limits.idleMs) this.stopEntry(e);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const e of this.entries.values()) this.stopEntry(e);
    this.entries.clear();
  }
}
