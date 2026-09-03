/**
 * Reservations an item's page should show (FR-INV-37): what a camp still means
 * for this item, before it is packed.
 */
import { type Item, resolveItem } from "./inventory";
import { reservations, type Reservation } from "./reservations";
import type { State } from "./replay";

/**
 * Live reservations that name this item today or later (not cancelled, not
 * yet ended): by its own id, by its own line in the `generics` list (a
 * generic or a pool, FR-RES-13), or, for a unit, by its parent generic's
 * line. A reservation naming a merged duplicate is read as naming the
 * survivor (FR-INV-13), so it shows here and not on the duplicate's page.
 */
export function itemReservations(state: State, it: Item, today: string): Reservation[] {
  const genericId = it.parent_id ?? it.id;
  return reservations(state).filter((r) => {
    if (r.ends < today) return false;
    const named = r.items.map((id) => resolveItem(state, id));
    return named.includes(it.id) || r.generics.some((g) => g.item_id === genericId);
  });
}
