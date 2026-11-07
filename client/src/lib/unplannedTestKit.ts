import type { Store } from "./store";

/**
 * A check-out under an event name that no reservation takes, as an older app build records it
 * (FR-RES-28). Tests only: a check-out through movement.ts now makes the reservation (FR-RES-38).
 */
export function checkOutUnplanned(store: Store, itemId: string, event: string, count?: number) {
  const holder_id = store.meta.user?.id ?? "";
  return store.record({
    entity_type: "item",
    entity_id: itemId,
    type: "checked_out",
    actor_id: holder_id,
    payload: { holder_id, event, reservation_id: null, ...(count === undefined ? {} : { count }) },
  });
}
