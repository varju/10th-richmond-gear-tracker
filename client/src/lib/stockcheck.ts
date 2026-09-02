/**
 * A stock check: walk one location, scan what is on the shelf, and see what is
 * misplaced and what is not there (FR-RPT-09). The phone knows where it is
 * only because a person said so, so nothing here is an event; the session is a
 * device setting and the answer is true for the walk.
 */
import { type Item, item, items } from "./inventory";
import type { State } from "./replay";
import type { StockCheck } from "./store";

export type { StockCheck };

/** Does this item belong where the person is standing? */
export function atHome(it: Item, check: StockCheck): boolean {
  if (it.home_location_id !== check.location_id) return false;
  return !check.sub_location || it.sub_location === check.sub_location;
}

const byName = (a: Item, b: Item) => a.name.localeCompare(b.name);

const seenItems = (state: State, check: StockCheck): Item[] =>
  check.seen.map((id) => item(state, id)).filter((it): it is Item => it !== undefined);

/** Scanned here, but this is not its home. */
export const misplaced = (state: State, check: StockCheck): Item[] =>
  seenItems(state, check)
    .filter((it) => !atHome(it, check))
    .sort(byName);

/** Scanned here, and this is its home. */
export const seenHere = (state: State, check: StockCheck): Item[] =>
  seenItems(state, check)
    .filter((it) => atHome(it, check))
    .sort(byName);

/** Should be on this shelf, is recorded as in, and has not been scanned. Out gear is not expected here. */
export function notSeen(state: State, check: StockCheck): Item[] {
  const seen = new Set(check.seen);
  return items(state)
    .filter((it) => !it.retired && it.status === "in" && atHome(it, check) && !seen.has(it.id))
    .sort(byName);
}

export const startCheck = (location_id: string, sub_location: string, now: number): StockCheck => ({
  location_id,
  ...(sub_location ? { sub_location } : {}),
  seen: [],
  started_at: now,
});

/** The same item scanned twice is one sighting. */
export const withSeen = (check: StockCheck, itemId: string): StockCheck =>
  check.seen.includes(itemId) ? check : { ...check, seen: [...check.seen, itemId] };
