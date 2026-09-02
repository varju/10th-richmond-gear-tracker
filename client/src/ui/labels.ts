/** Text the screens share. Pure functions over state. */
import type { Item } from "../lib/inventory";
import type { State } from "../lib/replay";
import type { SyncOutcome } from "../lib/sync";
import { ago } from "../lib/time";

/** Users arrive in the snapshot as entities; the holder is one of them. */
export function userName(state: State, id: string | null | undefined): string {
  if (!id) return "";
  return (state.user?.[id]?.name as string | undefined) ?? "(unknown person)";
}

/** "In", "Out · Alice", or "Missing" (FR-INV-19). */
export function statusLabel(state: State, it: Item): string {
  if (it.missing) return "Missing";
  return it.status === "out" ? `Out · ${userName(state, it.holder_id)}` : "In";
}

export function syncLabel(at: number | undefined, now: number, busy: boolean, outcome: SyncOutcome | null): string {
  if (busy) return "Syncing…";
  if (outcome?.ok === false && outcome.reason === "offline")
    return at ? `Offline. Last synced ${ago(now - at)}` : "Offline";
  if (outcome?.ok === false) return `Sync failed: ${outcome.message}`;
  return at ? `Synced ${ago(now - at)}` : "Not synced yet";
}

export const plural = (n: number, word: string): string => `${n} ${n === 1 ? word : `${word}s`}`;

/** "2024-03-01 · $249.99 · MEC": whichever parts are known (FR-INV-12). Empty when none are. */
export function boughtLabel(it: Pick<Item, "purchase_date" | "price" | "supplier">): string {
  return [it.purchase_date ?? "", typeof it.price === "number" ? `$${it.price.toFixed(2)}` : "", it.supplier ?? ""]
    .filter(Boolean)
    .join(" · ");
}
