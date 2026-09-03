/**
 * Reservations an item's page should show (FR-INV-37): what a camp still means
 * for this item, before it is packed.
 */
import type { Item } from "./inventory";
import { reservations, type Reservation } from "./reservations";
import type { State } from "./replay";

/**
 * Live reservations that name this item today or later (not cancelled, not
 * yet ended): by its own id, by its own line in the `generics` list (a
 * generic or a pool, FR-RES-13), or, for a unit, by its parent generic's
 * line.
 */
export function itemReservations(state: State, it: Item, today: string): Reservation[] {
  const genericId = it.parent_id ?? it.id;
  return reservations(state).filter(
    (r) => r.ends >= today && (r.items.includes(it.id) || r.generics.some((g) => g.item_id === genericId)),
  );
}
