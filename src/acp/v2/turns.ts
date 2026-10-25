import type * as v2 from "@agentclientprotocol/sdk/experimental/v2";

export interface TurnStop {
  stopReason: string;
  error?: { code: number; message: string; data?: unknown };
}

export type Settlement = { kind: "stop"; stop: TurnStop } | { kind: "failed"; error: unknown };

type Seen = { type: "user"; messageId: string } | { type: "running" } | { type: "idle"; stop: TurnStop };

interface Pending {
  id: number;
  phase: "sent" | "inserted";
  beforeAck: Seen[];
  settle: (s: Settlement) => void;
}

/** v2 state updates are aggregate session snapshots with no prompt id, and a
 *  repeated idle is not a new completion:
 *  https://agentclientprotocol.com/protocol/v2/draft/prompt-lifecycle#session-states */
export class SessionTurns {
  private run: "unknown" | "idle" | "running" | "requires_action" = "unknown";
  private pending: Pending[] = [];

  sent(id: number, settle: (s: Settlement) => void): void {
    this.pending.push({ id, phase: "sent", beforeAck: [], settle });
  }

  acked(id: number, messageId: string): void {
    const p = this.pending.find((x) => x.id === id);
    if (!p) return;
    const stop = idleAfterOwnEvidence(p.beforeAck, messageId);
    if (stop) {
      this.settle(p, { kind: "stop", stop });
      return;
    }
    p.phase = "inserted";
    p.beforeAck = [];
  }

  dropped(id: number): void {
    this.pending = this.pending.filter((p) => p.id !== id);
  }

  userMessage(messageId: string): void {
    for (const p of this.pending) if (p.phase === "sent") p.beforeAck.push({ type: "user", messageId });
  }

  unclaimedStop(update: v2.StateUpdate): TurnStop | undefined {
    const state = (update as { state: string }).state;
    if (state === "running" || state === "requires_action") {
      for (const p of this.pending) if (p.phase === "sent") p.beforeAck.push({ type: "running" });
      this.run = state;
      return undefined;
    }
    if (state !== "idle") return undefined;
    const raw = update as { stopReason?: string | null; error?: TurnStop["error"] | null };
    const stop: TurnStop = {
      stopReason: raw.stopReason ?? "end_turn",
      ...(raw.error ? { error: raw.error } : {}),
    };
    const was = this.run;
    this.run = "idle";
    const claimants = this.pending.filter((p) => p.phase === "inserted");
    for (const p of claimants) this.settle(p, { kind: "stop", stop });
    const waiting = this.pending.filter((p) => p.phase === "sent");
    for (const p of waiting) p.beforeAck.push({ type: "idle", stop });
    if (claimants.length || waiting.length) return undefined;
    return was === "running" || was === "requires_action" ? stop : undefined;
  }

  failAll(error: unknown): void {
    for (const p of [...this.pending]) this.settle(p, { kind: "failed", error });
  }

  private settle(p: Pending, s: Settlement): void {
    this.pending = this.pending.filter((x) => x !== p);
    p.settle(s);
  }
}

function idleAfterOwnEvidence(seen: Seen[], messageId: string): TurnStop | undefined {
  const own = seen.map((s) => s.type === "user" && s.messageId === messageId).lastIndexOf(true);
  let evidence = own >= 0;
  for (const s of seen.slice(own + 1)) {
    if (s.type === "running") evidence = true;
    else if (s.type === "idle" && evidence) return s.stop;
  }
  return undefined;
}
