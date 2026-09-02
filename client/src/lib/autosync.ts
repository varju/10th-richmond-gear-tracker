/**
 * Unsent records go to the server as soon as they exist. They pile up only
 * when a sync fails; then this retries with a growing delay until one
 * succeeds or the network comes back (FR-OFF-03).
 *
 * Nothing here runs a sync itself. `run` is the shell's one-at-a-time sync;
 * it answers `undefined` when one is already in flight, and this looks again
 * shortly after.
 */
import type { Store } from "./store";
import type { SyncOutcome } from "./sync";

/** A save writes several events in a row; one push carries them all. */
export const FLUSH_MS = 250;
/** After a failure: back off, capped at the last entry. */
export const RETRY_MS = [5_000, 15_000, 60_000, 300_000];

export interface Timing {
  flushMs: number;
  retryMs: number[];
}

export function autoSync(
  store: Store,
  run: () => Promise<SyncOutcome | undefined>,
  timing: Timing = { flushMs: FLUSH_MS, retryMs: RETRY_MS },
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let stopped = false;

  function schedule(ms: number): void {
    if (timer !== undefined) return;
    timer = setTimeout(fire, ms);
  }

  async function fire(): Promise<void> {
    timer = undefined;
    if (stopped || store.pending.length === 0) return;
    const outcome = await run();
    if (stopped) return;
    if (outcome === undefined) return schedule(timing.flushMs);
    if (outcome.ok) {
      failures = 0;
      if (store.pending.length > 0) schedule(timing.flushMs);
      return;
    }
    // Signing in syncs; nothing to retry until then.
    if (outcome.reason === "signed_out") return;
    failures++;
    schedule(timing.retryMs[Math.min(failures, timing.retryMs.length) - 1]!);
  }

  function changed(): void {
    if (store.pending.length > 0) schedule(timing.flushMs);
  }

  function online(): void {
    failures = 0;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    changed();
  }

  const unsubscribe = store.subscribe(changed);
  window.addEventListener("online", online);
  changed();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    window.removeEventListener("online", online);
  };
}
