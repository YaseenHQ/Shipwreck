import { useRef, useSyncExternalStore } from "react";
import { getState, subscribe, type State } from "./store";

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

/**
 * Subscribe to a few store fields. The component re-renders only when one
 * of the picked values changes identity — streaming deltas, which replace
 * `entries`, leave it alone.
 */
export function useStoreSlice<T extends Record<string, unknown>>(pick: (s: State) => T): T {
  const cache = useRef<T | null>(null);
  const read = (): T => {
    const next = pick(getState());
    const prev = cache.current;
    if (prev && shallowEqual(prev, next)) return prev;
    cache.current = next;
    return next;
  };
  return useSyncExternalStore(subscribe, read);
}
