import React from "react";
import type { ThreadActivity, ThreadMeta } from "../../src/types";
import { IconSpinner } from "../icons";

export type ActivityState = ThreadActivity["state"];

export const ACTIVITY_LABEL: Record<ActivityState, string> = {
  running: "Working",
  needs_input: "Needs input",
  done: "Done",
  failed: "Failed",
};

const SUMMARY_WORD: Record<ActivityState, string> = {
  running: "working",
  needs_input: "needs input",
  done: "done",
  failed: "failed",
};

/** Most urgent first. */
const ORDER: ActivityState[] = ["needs_input", "failed", "running", "done"];

/** Background activity per thread; the open thread is excluded. */
export function activityByThread(
  list: readonly ThreadActivity[],
  activeThreadId?: string,
): Map<string, ActivityState> {
  const map = new Map<string, ActivityState>();
  for (const a of list) if (a.threadId !== activeThreadId) map.set(a.threadId, a.state);
  return map;
}

export function ActivityBadge({
  state,
  label,
}: {
  state: ActivityState;
  label?: boolean;
}): React.JSX.Element {
  const text = ACTIVITY_LABEL[state];
  return (
    <span
      className={`act act-${state}`}
      title={state === "done" ? "Finished in the background" : text}
    >
      {state === "running" ? (
        <IconSpinner size={11} className="act-spin" />
      ) : (
        <span className="act-dot" aria-hidden="true" />
      )}
      {label ? <span className="act-label">{text}</span> : <span className="sr-only">{text}</span>}
    </span>
  );
}

/** Compact summary of threads working off screen; opens the threads list. */
export function ActivityStrip({
  activity,
  threads,
  activeThreadId,
  onOpen,
}: {
  activity: readonly ThreadActivity[];
  threads: readonly ThreadMeta[];
  activeThreadId?: string;
  onOpen: () => void;
}): React.JSX.Element | null {
  const items = activity.filter((a) => a.threadId !== activeThreadId);
  if (!items.length) return null;
  const counts = ORDER.map((s) => ({ s, n: items.filter((a) => a.state === s).length })).filter(
    (c) => c.n > 0,
  );
  const titleOf = (id: string) => threads.find((t) => t.id === id)?.title.trim() || "Untitled chat";
  const tip = items.map((a) => `${titleOf(a.threadId)} — ${ACTIVITY_LABEL[a.state]}`).join("\n");
  const summary = counts.map((c) => `${c.n} ${SUMMARY_WORD[c.s]}`).join(", ");
  return (
    <button
      className="bg-activity"
      onClick={onOpen}
      title={tip}
      aria-label={`Background threads: ${summary}. Show threads`}
    >
      {counts.map((c) => (
        <span key={c.s} className={`bg-activity-item act-${c.s}`}>
          {c.s === "running" ? (
            <IconSpinner size={11} className="act-spin" />
          ) : (
            <span className="act-dot" aria-hidden="true" />
          )}
          {c.n}
          <span className="bg-activity-word">{SUMMARY_WORD[c.s]}</span>
        </span>
      ))}
    </button>
  );
}
