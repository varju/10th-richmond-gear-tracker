/**
 * Notes on any entity: an item, one of its movements, or a repair ticket's
 * comments (FR-OUT-13, FR-REP-06). A correction is appended; the original stays
 * in the log (FR-OUT-16).
 */
import type { Note } from "./replay";
import type { Store } from "./store";

export interface EntityRef {
  entity_type: string;
  entity_id: string;
}

function actor(store: Store): string {
  const id = store.meta.user?.id;
  if (!id) throw new Error("not signed in");
  return id;
}

function existing(store: Store, on: EntityRef) {
  const entity = store.state[on.entity_type]?.[on.entity_id];
  if (!entity) throw new Error(`no such ${on.entity_type}`);
  return entity;
}

/** A note on the entity, or on one of an item's movements when movementId is given. */
export async function addNote(store: Store, on: EntityRef, text: string, movementId?: string) {
  existing(store, on);
  const payload: Record<string, unknown> = { text: text.trim() };
  if (movementId) payload.movement_id = movementId;
  return store.record({ ...on, type: "note_added", actor_id: actor(store), payload });
}

export async function correctNote(store: Store, on: EntityRef, noteId: string, text: string) {
  const notes = (existing(store, on).notes ?? []) as Note[];
  if (!notes.some((n) => n.id === noteId)) throw new Error("no such note");
  return store.record({
    ...on,
    type: "note_corrected",
    actor_id: actor(store),
    payload: { note_id: noteId, text: text.trim() },
  });
}
