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

export type OutSort = "holder" | "item" | "days" | "reservation";

const SORTS: OutSort[] = ["holder", "item", "days", "reservation"];

/** A sort and which way it points. The phone's list and the desk's table share both (FR-RPT-12). */
export interface OutOrder {
  sort: OutSort;
  up: boolean;
}

export interface OutRow extends OutItem {
  holderId: string;
  holderName: string;
}

/** Every out row, flattened out of the holder grouping, in that same order. */
export function outRows(report: OutReport): OutRow[] {
  return report.holders.flatMap((h) => h.items.map((it) => ({ ...it, holderId: h.id, holderName: h.name })));
}

/** A pool lists once per holder (FR-RPT-11), so the item id alone does not tell two rows apart. */
export const rowKey = (row: OutRow): string => `${row.holderId}:${row.item.id}`;

/** Sorts a bare event name after any real one, so ungrouped gear falls to the end. */
export const eventKey = (event: string | null): string => event ?? "￿";

/** Which way a column reads on the first click: longest out first for time, A to Z for the rest. */
export const firstDirection = (sort: OutSort): boolean => sort !== "days";

/** Holder ascending is the default, so it is the one arrangement the URL leaves out. */
export function readOrder(query: URLSearchParams): OutOrder {
  return { sort: SORTS.find((s) => s === query.get("sort")) ?? "holder", up: query.get("dir") !== "down" };
}

export function orderParams({ sort, up }: OutOrder): URLSearchParams {
  const params = new URLSearchParams();
  if (sort !== "holder") params.set("sort", sort);
  if (!up) params.set("dir", "down");
  return params;
}

/**
 * Reorders flattened rows for the chosen arrangement (FR-RPT-12). Ties break
 * the way whatIsOut already groups them — holder name, longest out first, then
 * item name — and keep that direction whichever way the sort itself points.
 */
export function sortRows(state: State, rows: OutRow[], { sort, up }: OutOrder): OutRow[] {
  const name = (row: OutRow) => displayName(state, row.item);
  const key = (row: OutRow): string | number => {
    switch (sort) {
      case "holder":
        return row.holderName;
      case "item":
        return name(row);
      case "days":
        return row.days;
      case "reservation":
        return eventKey(row.event);
    }
  };
  return [...rows].sort((a, b) => {
    const [ak, bk] = [key(a), key(b)];
    const order = typeof ak === "number" && typeof bk === "number" ? ak - bk : String(ak).localeCompare(String(bk));
    return (
      (up ? order : -order) ||
      a.holderName.localeCompare(b.holderName) ||
      b.days - a.days ||
      name(a).localeCompare(name(b))
    );
  });
}
