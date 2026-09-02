/**
 * Check-out, check-in, transfer, and the notes that ride on them. Each is one
 * or two events on the store. Nothing here talks to the server; the caller
 * syncs afterwards (FR-OFF-03).
 */
import { seen } from "./actions";
import { item, type Item } from "./inventory";
import * as notes from "./notes";
import type { Movement, Note } from "./replay";
import type { Store } from "./store";

export interface MoveOptions {
  /** The session's event name (FR-OUT-05). */
  event?: string;
  /** A note on this movement (FR-OUT-15). */
  note?: string;
}

function actor(store: Store): string {
  const id = store.meta.user?.id;
  if (!id) throw new Error("not signed in");
  return id;
}

function current(store: Store, itemId: string): Item {
  const it = item(store.state, itemId);
  if (!it) throw new Error("no such item");
  return it;
}

async function move(store: Store, itemId: string, type: string, payload: Record<string, unknown>, note?: string) {
  const movement = await store.record({
    entity_type: "item",
    entity_id: itemId,
    type,
    actor_id: actor(store),
    payload,
  });
  if (note?.trim()) await addNote(store, itemId, note, movement.id);
  return movement;
}

/** Take it. The holder is whoever is signed in; a note covers anyone else (FR-OUT-04, FR-OUT-15). */
export async function checkOut(store: Store, itemId: string, options: MoveOptions = {}) {
  const it = current(store, itemId);
  if (it.retired) throw new Error("retired items cannot be checked out");
  if (it.status === "out") throw new Error("already out; transfer it instead");
  return move(
    store,
    itemId,
    "checked_out",
    { holder_id: actor(store), event: options.event?.trim() || null },
    options.note,
  );
}

/** Anyone can bring anything back (FR-OUT-08). */
export async function checkIn(store: Store, itemId: string, options: MoveOptions = {}) {
  const it = current(store, itemId);
  if (it.status !== "out") throw new Error("already in");
  const movement = await move(store, itemId, "checked_in", {}, options.note);
  await seen(store, itemId);
  return movement;
}

/** Take something someone else has (FR-OUT-12). Names the check-out it replaces, so replay knows it is not a conflict. */
export async function transfer(store: Store, itemId: string, options: MoveOptions = {}) {
  const it = current(store, itemId);
  if (it.retired) throw new Error("retired items cannot be checked out");
  const previous = it.movement as Movement | undefined;
  if (it.status !== "out" || !previous) throw new Error("not out; check it out instead");
  return move(
    store,
    itemId,
    "checked_out",
    { holder_id: actor(store), event: options.event?.trim() || null, supersedes: previous.id },
    options.note,
  );
}

const onItem = (itemId: string) => ({ entity_type: "item", entity_id: itemId });

/** A note on the item, or on one of its movements (FR-OUT-13). */
export const addNote = (store: Store, itemId: string, text: string, movementId?: string) =>
  notes.addNote(store, onItem(itemId), text, movementId);

/** The original stays in the log; the item shows the new text (FR-OUT-16). */
export const correctNote = (store: Store, itemId: string, noteId: string, text: string) =>
  notes.correctNote(store, onItem(itemId), noteId, text);

export interface HistoryEntry {
  id: string;
  type: "checked_out" | "checked_in";
  actor_id: string;
  holder_id: string | null;
  event: string | null;
  supersedes: string | null;
  at: number;
  notes: Note[];
}

/** The item's movements this device knows about, newest first, each with its notes (FR-INV-09). */
export function history(store: Store, itemId: string): HistoryEntry[] {
  const notes = (item(store.state, itemId)?.notes ?? []) as Note[];
  return store
    .eventsFor("item", itemId)
    .filter((e) => e.type === "checked_out" || e.type === "checked_in")
    .map((e) => ({
      id: e.id,
      type: e.type as HistoryEntry["type"],
      actor_id: e.actor_id,
      holder_id: (e.payload.holder_id as string | undefined) ?? null,
      event: (e.payload.event as string | undefined) ?? null,
      supersedes: (e.payload.supersedes as string | undefined) ?? null,
      at: e.effective_at,
      notes: notes.filter((n) => n.movement_id === e.id),
    }))
    .reverse();
}
