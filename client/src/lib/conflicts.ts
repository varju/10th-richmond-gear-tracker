/**
 * Conflicts a machine will not guess at (FR-OFF-10): two check-outs of one
 * item from different devices with no check-in between. Replay records each
 * one on the item and never clears it; which ones are still open is decided
 * here, from state, with no replay change.
 */
import { type Item, items } from "./inventory";
import type { Movement, State } from "./replay";
import type { Store } from "./store";

export interface DoubleCheckout {
  kind: "double_checkout";
  events: [Movement, Movement];
}

export interface OpenConflict {
  item: Item;
  earlier: Movement;
  later: Movement;
}

/**
 * Open means nothing has settled it: the later check-out is still the item's
 * current movement, and nobody has reviewed it. A check-in or a transfer after
 * it closes it by moving on; a review closes it by naming it.
 */
function openFor(it: Item): OpenConflict | undefined {
  const current = it.movement?.id;
  if (!current) return undefined;
  const reviewed = it.reviewed_movement ?? null;
  for (const c of (it.conflicts ?? []) as DoubleCheckout[]) {
    const [earlier, later] = c.events;
    if (later.id === current && reviewed !== later.id) return { item: it, earlier, later };
  }
  return undefined;
}

/** Every open conflict, oldest later check-out first. */
export function openConflicts(state: State): OpenConflict[] {
  return items(state)
    .map(openFor)
    .filter((c): c is OpenConflict => c !== undefined)
    .sort((a, b) => a.later.at - b.later.at || (a.item.id < b.item.id ? -1 : 1));
}

export function hasOpenConflict(state: State, itemId: string): boolean {
  return openConflicts(state).some((c) => c.item.id === itemId);
}

/** The Quartermaster has looked and the current holder stands. One field, so the log's movements are untouched. */
export async function reviewConflict(store: Store, itemId: string): Promise<void> {
  const actor = store.meta.user?.id;
  if (!actor) throw new Error("not signed in");
  const open = openConflicts(store.state).find((c) => c.item.id === itemId);
  if (!open) throw new Error("no open conflict on this item");
  const before = open.item;
  await store.record({
    entity_type: "item",
    entity_id: itemId,
    type: "field_changed",
    actor_id: actor,
    payload: { field: "reviewed_movement", value: open.later.id, old: before.reviewed_movement ?? null },
  });
}
