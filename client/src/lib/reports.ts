/**
 * The first report: what is out, and who has it (FR-RPT-01), with gear out
 * longer than the group's period flagged (FR-OUT-14, FR-RPT-05). Pure
 * functions over state; the device answers this with no network.
 */
import { DAY_MS } from "./clock";
import { displayName, group, isPool, type Item, items, movable, poolCounts } from "./inventory";
import type { State } from "./replay";

export interface OutItem {
  item: Item;
  /** Whole days since the check-out. Zero for a pool's line: a holder's count can be the sum of
   * check-outs at different times, so there is no one day to show (FR-RPT-11). */
  days: number;
  event: string | null;
  overdue: boolean;
  /** Set only for a pool's line (FR-RPT-11): how many this holder has. */
  count?: number;
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

/** How much gear is out: units and single items, never a generic. Missing gear is not out (FR-INV-19). */
export const outCount = (state: State): number =>
  movable(state).filter((it) => it.status === "out" && !it.missing).length;

export const daysOut = (it: Item, now: number): number => Math.floor(Math.max(0, now - (it.since ?? now)) / DAY_MS);

/** Out longer than the group-wide period. No period set means nothing is overdue. */
export function isOverdue(state: State, it: Item, now: number): boolean {
  const days = group(state).overdue_days;
  return it.status === "out" && typeof days === "number" && days > 0 && daysOut(it, now) >= days;
}

const holderName = (state: State, id: string): string =>
  (state.user?.[id]?.name as string | undefined) ?? "(unknown person)";

/**
 * Everyone who has something, by name; each person's gear longest out first.
 * Missing gear is not out (FR-INV-19). A pool has no single "out": it lists
 * once per holder, with its count, and carries no days or event of its own
 * (FR-RPT-11).
 */
export function whatIsOut(state: State, now: number): OutReport {
  const byHolder = new Map<string, OutItem[]>();
  let overdue = 0;
  for (const it of items(state)) {
    if (isPool(it)) {
      for (const out of poolCounts(it).out) {
        const entry: OutItem = { item: it, days: 0, event: null, overdue: false, count: out.count };
        byHolder.set(out.holder_id, [...(byHolder.get(out.holder_id) ?? []), entry]);
      }
      continue;
    }
    if (it.status !== "out" || it.missing) continue;
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
      items: list.sort(
        (a, b) => b.days - a.days || displayName(state, a.item).localeCompare(displayName(state, b.item)),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { holders, total: holders.reduce((n, h) => n + h.items.length, 0), overdue };
}
