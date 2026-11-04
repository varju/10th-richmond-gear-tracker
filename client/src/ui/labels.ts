/** Text the screens share. Pure functions over state. */
import { type Item, type Row, userName } from "../lib/inventory";
import type { State } from "../lib/replay";
import type { SyncOutcome } from "../lib/sync";
import { ago } from "../lib/time";

export { userName };

/** "In", "Out · Alice", or "Missing" (FR-INV-19). */
export function statusLabel(state: State, it: Item): string {
  if (it.missing) return "Missing";
  return it.status === "out" ? `Out · ${userName(state, it.holder_id)}` : "In";
}

/** A generic's or pool's units as "2 in · 1 out", plus "· 1 missing" for one with any. */
export function countsLabel(row: Row & { kind: "generic" | "pool" }): string {
  if (row.kind === "pool") {
    const { in: n, out, missing } = row.pool;
    const away = out.reduce((sum, o) => sum + o.count, 0);
    return `${n} in · ${away} out${missing > 0 ? ` · ${missing} missing` : ""}`;
  }
  const { in: n, out, missing } = row.counts;
  return `${n} in · ${out} out${missing > 0 ? ` · ${missing} missing` : ""}`;
}

/**
 * The scan card's line on who has it (FR-OUT-06): "In", "You have this · 2 days ago · Spring camp",
 * or "Out with Sam · 2 days ago".
 */
export function holdingLabel(state: State, it: Item, me: string | undefined, now: number): string {
  if (it.missing) return "Missing";
  if (it.status !== "out") return "In";
  const since = it.since != null ? ` · ${ago(now - it.since)}` : "";
  const cleaner = it.movement?.cleaner;
  if (cleaner) {
    // The Scouter who handed it over is still the one to chase (FR-OUT-46).
    const via = it.holder_id === me ? "you" : userName(state, it.holder_id);
    return `Out for cleaning with ${cleaner}${since} · via ${via}`;
  }
  const who = it.holder_id === me ? "You have this" : `Out with ${userName(state, it.holder_id)}`;
  const event = typeof it.movement?.event === "string" ? it.movement.event : null;
  return `${who}${since}${event ? ` · ${event}` : ""}`;
}

export function syncLabel(at: number | undefined, now: number, busy: boolean, outcome: SyncOutcome | null): string {
  if (busy) return "Syncing…";
  if (outcome?.ok === false && outcome.reason === "offline")
    return at ? `Offline. Last synced ${ago(now - at)}` : "Offline";
  if (outcome?.ok === false) return `Sync failed: ${outcome.message}`;
  return at ? `Synced ${ago(now - at)}` : "Not synced yet";
}

export const plural = (n: number, word: string): string => `${n} ${n === 1 ? word : `${word}s`}`;

/** "2024-03-01" (FR-INV-12). Empty when not known. */
export function boughtLabel(it: Pick<Item, "purchase_date">): string {
  return it.purchase_date ?? "";
}
