/**
 * The whole record when there is signal; what this device holds when there is
 * not (FR-INV-31).
 *
 * A device keeps 90 days of events (NFR-DATA-03), which is right for a locker
 * and wrong for "when did we buy this tent". The server keeps everything, so
 * the history screens ask it first and fall back to the device.
 *
 * Both answers are events, so both go through the same `Log` and draw the same
 * rows. Work recorded here and not yet pushed is added to the server's answer,
 * because a note written a minute ago must not vanish when the signal returns.
 */
import { useEffect, useState } from "react";
import type { Api } from "./api";
import { replay, replayOrder, type ReplayEvent, type State } from "./replay";
import type { Store } from "./store";

/** Where a history screen reads its events. `Store` is one; the server's answer is another. */
export interface Log {
  state: State;
  eventsFor(entity_type: string, entity_id: string): ReplayEvent[];
}

/** No `navigator` in some test runners, and no reason to hold back when it says nothing. */
const online = (): boolean => typeof navigator === "undefined" || navigator.onLine !== false;

/**
 * One entity's whole record, or several entities' when a merge means a page
 * reads more than one id. Null until it arrives, and for good if it does not:
 * the caller falls back to the store and says so.
 */
export function useRecord(store: Store, entity_type: string, ids: string[], api?: Api): Log | null {
  // A string, so a fresh array of the same ids does not fetch again.
  const key = ids.join(" ");
  const [fetched, setFetched] = useState<{ key: string; events: ReplayEvent[] } | null>(null);

  useEffect(() => {
    if (!api || !online() || !key) {
      setFetched(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const answers = await Promise.all(key.split(" ").map((id) => api.history(entity_type, id)));
        if (live) setFetched({ key, events: answers.flatMap((a) => a.data.events) });
      } catch {
        // Offline, or the server said no. What this device knows still stands.
        if (live) setFetched(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [api, entity_type, key]);

  if (!fetched || fetched.key !== key) return null;
  return { state: store.state, eventsFor: (type, id) => merged(store, fetched.events, type, id) };
}

/**
 * Every entity of one kind, replayed into state. The repair report reads its
 * whole record this way, because it is a list of tickets rather than one.
 */
export function useTypeRecord(store: Store, entity_type: string, api?: Api): State | null {
  const [fetched, setFetched] = useState<ReplayEvent[] | null>(null);

  useEffect(() => {
    if (!api || !online()) {
      setFetched(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const answer = await api.history(entity_type);
        if (live) setFetched(answer.data.events);
      } catch {
        if (live) setFetched(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [api, entity_type]);

  if (!fetched) return null;
  const unsent = store.pending.filter((e) => e.entity_type === entity_type);
  // One kind replaced wholesale; the rest of state is left alone, so names still resolve.
  return { ...store.state, [entity_type]: replay([...fetched, ...unsent])[entity_type] ?? {} };
}

/** The server's events for one entity, plus anything recorded here it has not seen. */
function merged(store: Store, fetched: ReplayEvent[], entity_type: string, entity_id: string): ReplayEvent[] {
  const theirs = fetched.filter((e) => e.entity_type === entity_type && e.entity_id === entity_id);
  const known = new Set(theirs.map((e) => e.id));
  const mine = store.eventsFor(entity_type, entity_id).filter((e) => !known.has(e.id));
  return [...theirs, ...mine].sort(replayOrder);
}
