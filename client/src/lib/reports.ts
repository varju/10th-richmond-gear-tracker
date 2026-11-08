/**
 * The first report: what is out, and who has it (FR-RPT-01), with gear out
 * longer than the group's period flagged (FR-OUT-14, FR-RPT-05). Pure
 * functions over state; the device answers this with no network.
 */
import { eventNameKey, tidyName } from "./calendar";
import { DAY_MS } from "./clock";
import { displayName, group, isPool, type Item, items, movable, poolCounts, poolLots, userName } from "./inventory";
import { cleanerKey, type State } from "./replay";

export interface OutItem {
  item: Item;
  /** Whole days since the check-out. Zero for a pool's line: a holder's count can be the sum of
   * check-outs at different times, so there is no one day to show (FR-RPT-11). */
  days: number;
  event: string | null;
  overdue: boolean;
  /** Set only for a pool's line (FR-RPT-11): how many this holder has under this event. */
  count?: number;
  /** Who took it home to clean (FR-OUT-46); absent on gear that is simply out. */
  cleaner?: string;
}

/** What a line is out for: its event, and "At home with Smith" when it went home (FR-OUT-46). */
export const outFor = (entry: Pick<OutItem, "event" | "cleaner">): string =>
  [entry.event, entry.cleaner && `At home with ${entry.cleaner}`].filter(Boolean).join(" · ");

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

/** How many things of What is out are under this person: the same rules as whatIsOut, without building it. */
export const heldBy = (state: State, holderId: string): number =>
  items(state).filter((it) =>
    isPool(it)
      ? poolCounts(it).out.some((o) => o.holder_id === holderId)
      : it.status === "out" && !it.missing && it.holder_id === holderId,
  ).length;

export const daysOut = (it: Item, now: number): number => Math.floor(Math.max(0, now - (it.since ?? now)) / DAY_MS);

/** Out longer than the group-wide period. No period set means nothing is overdue. */
export function isOverdue(state: State, it: Item, now: number): boolean {
  const days = group(state).overdue_days;
  return it.status === "out" && typeof days === "number" && days > 0 && daysOut(it, now) >= days;
}

/**
 * Everyone who has something, by name; each person's gear longest out first.
 * Missing gear is not out (FR-INV-19). A pool has no single "out": it lists
 * once per holder and event, with its count, and carries no days (FR-RPT-11).
 */
export function whatIsOut(state: State, now: number): OutReport {
  const byHolder = new Map<string, OutItem[]>();
  for (const it of items(state)) {
    if (isPool(it)) {
      for (const out of poolLots(it)) {
        const lines = new Map<string, OutItem>();
        const add = (event: string | null, count: number, cleaner?: string) => {
          const key = `${event ? eventNameKey(event) : ""}\0${cleaner ? cleanerKey(cleaner) : ""}`;
          const line = lines.get(key);
          if (line) line.count = (line.count ?? 0) + count;
          else {
            const made: OutItem = { item: it, days: 0, event: event ? tidyName(event) : null, overdue: false, count };
            if (cleaner) made.cleaner = tidyName(cleaner);
            lines.set(key, made);
          }
        };
        for (const lot of out.lots) add(lot.event, lot.count, lot.cleaner);
        if (out.unknown) add(null, out.unknown);
        byHolder.set(out.holder_id, [...(byHolder.get(out.holder_id) ?? []), ...lines.values()]);
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
    if (it.movement?.cleaner) entry.cleaner = tidyName(it.movement.cleaner);
    const key = it.holder_id ?? "";
    byHolder.set(key, [...(byHolder.get(key) ?? []), entry]);
  }
  const holders = [...byHolder.entries()]
    .map(([id, list]) => ({
      id,
      name: id ? userName(state, id) : "(no holder)",
      items: list.sort(
        (a, b) => b.days - a.days || displayName(state, a.item).localeCompare(displayName(state, b.item)),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return tallied(holders);
}

function tallied(holders: Holder[]): OutReport {
  // A pool under two events is still one thing this person has.
  const total = holders.reduce((n, h) => n + new Set(h.items.map((entry) => entry.item.id)).size, 0);
  const overdue = holders.reduce((n, h) => n + h.items.filter((entry) => entry.overdue).length, 0);
  return { holders, total, overdue };
}

export interface OutEvent {
  key: string;
  name: string;
}

/** The events gear is out under, by name. */
function outEvents(report: OutReport): OutEvent[] {
  const found = new Map<string, string>();
  for (const entry of report.holders.flatMap((h) => h.items)) {
    const key = eventNameKey(entry.event ?? "");
    if (key && !found.has(key)) found.set(key, tidyName(entry.event ?? ""));
  }
  return [...found].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The report the URL asks for: one event's gear (FR-RPT-13), or everything.
 * An event with nothing left out is ignored, so `event` is empty.
 */
export function readOutEvent(
  all: OutReport,
  query: URLSearchParams,
): { report: OutReport; events: OutEvent[]; event: string; eventName: string } {
  const events = outEvents(all);
  const wanted = eventNameKey(query.get("event") ?? "");
  const chosen = events.find((e) => e.key === wanted);
  if (!chosen) return { report: all, events, event: "", eventName: "" };
  const holders = all.holders
    .map((h) => ({ ...h, items: h.items.filter((entry) => entry.event && eventNameKey(entry.event) === wanted) }))
    .filter((h) => h.items.length > 0);
  return { report: tallied(holders), events, event: wanted, eventName: chosen.name };
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

/** A pool lists once per holder and event (FR-RPT-11), so the item id alone does not tell two rows apart. */
export const rowKey = (row: OutRow): string =>
  `${row.holderId}:${row.item.id}:${row.event ?? ""}:${row.cleaner ? cleanerKey(row.cleaner) : ""}`;

/** Sorts a bare event name after any real one, so ungrouped gear falls to the end. */
export const eventKey = (event: string | null): string => event ?? "￿";

/** Which way a column reads on the first click: longest out first for time, A to Z for the rest. */
export const firstDirection = (sort: OutSort): boolean => sort !== "days";

/** Holder ascending is the default, so it is the one arrangement the URL leaves out. */
export function readOrder(query: URLSearchParams): OutOrder {
  return { sort: SORTS.find((s) => s === query.get("sort")) ?? "holder", up: query.get("dir") !== "down" };
}

export function orderParams({ sort, up }: OutOrder, event = ""): URLSearchParams {
  const params = new URLSearchParams();
  if (event) params.set("event", event);
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
