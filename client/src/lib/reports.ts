/**
 * The first report: what is out, and who has it (FR-RPT-01), with gear out
 * longer than the group's period flagged (FR-OUT-14, FR-RPT-05). Pure
 * functions over state; the phone answers this with no network.
 */
import { DAY_MS } from "./clock";
import { group, type Item, items } from "./inventory";
import type { State } from "./replay";

export interface OutItem {
  item: Item;
  /** Whole days since the check-out. */
  days: number;
  event: string | null;
  overdue: boolean;
}

export interface Holder {
  id: string;
  name: string;
  items: OutItem[];
}

export interface OutReport {
  holders: Holder[];
  total: number;
  overdue: number;
}

export const daysOut = (it: Item, now: number): number => Math.floor(Math.max(0, now - (it.since ?? now)) / DAY_MS);

/** Out longer than the group-wide period. No period set means nothing is overdue. */
export function isOverdue(state: State, it: Item, now: number): boolean {
  const days = group(state).overdue_days;
  return it.status === "out" && typeof days === "number" && days > 0 && daysOut(it, now) >= days;
}

const holderName = (state: State, id: string): string =>
  (state.user?.[id]?.name as string | undefined) ?? "(unknown person)";

/** Everyone who has something, by name; each person's gear longest out first. */
export function whatIsOut(state: State, now: number): OutReport {
  const byHolder = new Map<string, OutItem[]>();
  let overdue = 0;
  for (const it of items(state)) {
    if (it.status !== "out") continue;
    const entry: OutItem = {
      item: it,
      days: daysOut(it, now),
      event: typeof it.movement?.event === "string" ? it.movement.event : null,
      overdue: isOverdue(state, it, now),
    };
    if (entry.overdue) overdue++;
    const key = it.holder_id ?? "";
    byHolder.set(key, [...(byHolder.get(key) ?? []), entry]);
  }
  const holders = [...byHolder.entries()]
    .map(([id, list]) => ({
      id,
      name: id ? holderName(state, id) : "(no holder)",
      items: list.sort((a, b) => b.days - a.days || a.item.name.localeCompare(b.item.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { holders, total: holders.reduce((n, h) => n + h.items.length, 0), overdue };
}
