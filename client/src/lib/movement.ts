/**
 * Check-out, check-in, transfer, and the notes that ride on them. Each is one
 * or two events on the store. Nothing here talks to the server; the caller
 * syncs afterwards (FR-OFF-03).
 */
import { seen } from "./actions";
import { aliases, isPool, item, type Item, poolCounts } from "./inventory";
import * as notes from "./notes";
import type { Log } from "./record";
import { type Movement, type Note, replayOrder } from "./replay";
import type { Store } from "./store";

export interface MoveOptions {
  /** The session's event name (FR-OUT-05). */
  event?: string;
  /** The reservation this check-out packs (FR-RES-13). Only a check-out that carries it counts
   * toward that reservation's progress; the event name alone is not enough (it repeats year to year). */
  reservation_id?: string;
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
  // A generic is a name several things share; the unit in your hand is what moves (FR-INV-21).
  if (it.generic) throw new Error("a generic item does not move; its units do");
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
  if (it.merged_into) throw new Error("merged into another item");
  if (it.status === "out") throw new Error("already out; transfer it instead");
  return move(
    store,
    itemId,
    "checked_out",
    { holder_id: actor(store), event: options.event?.trim() || null, reservation_id: options.reservation_id ?? null },
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

function poolItem(store: Store, itemId: string): Item {
  const it = item(store.state, itemId);
  if (!it) throw new Error("no such item");
  if (!isPool(it)) throw new Error("not a pool");
  return it;
}

export interface PoolCheckOutOptions extends MoveOptions {
  count: number;
}

export interface PoolCheckInOptions {
  count: number;
  /** Return on someone else's behalf (FR-OUT-23). Defaults to the actor when omitted. */
  holder_id?: string;
  note?: string;
}

/**
 * Take some of a pool (FR-OUT-22): several people may have some out at once,
 * against an event like any check-out. Taking more than are in warns, never
 * blocks; that is for the caller to say, not this.
 */
export async function checkOutPool(store: Store, itemId: string, options: PoolCheckOutOptions) {
  const it = poolItem(store, itemId);
  if (it.retired) throw new Error("retired items cannot be checked out");
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error("pick a count of at least 1");
  return move(
    store,
    itemId,
    "checked_out",
    {
      holder_id: actor(store),
      count: options.count,
      event: options.event?.trim() || null,
      reservation_id: options.reservation_id ?? null,
    },
    options.note,
  );
}

/**
 * Return some of a pool (FR-OUT-23): what is left over stays against the holder's name. Anyone
 * can return another's, named by `holder_id`; it defaults to whoever is signed in. Returning more
 * than that holder has out would inflate `pool_in` for good (replay floors `pool_out` at zero but
 * still credits the whole count), so it is refused here instead.
 */
export async function checkInPool(store: Store, itemId: string, options: PoolCheckInOptions) {
  const it = poolItem(store, itemId);
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error("pick a count of at least 1");
  const holder = options.holder_id ?? actor(store);
  const has = poolCounts(it).out.find((o) => o.holder_id === holder)?.count ?? 0;
  if (has === 0) throw new Error(`nothing out to ${holder}`);
  if (options.count > has) throw new Error(`only ${has} out to ${holder}`);
  const payload: Record<string, unknown> = { count: options.count };
  if (holder !== actor(store)) payload.holder_id = holder;
  return move(store, itemId, "checked_in", payload, options.note);
}

/** How many are in right now, with a reason (FR-INV-35). What is already out is untouched; anyone signed in may record one. */
export async function recount(store: Store, itemId: string, count: number, reason: string) {
  poolItem(store, itemId);
  if (!Number.isInteger(count) || count < 0) throw new Error("pick a count of zero or more");
  const why = reason.trim();
  if (!why) throw new Error("say why");
  return move(store, itemId, "recounted", { count, reason: why });
}

/**
 * Take something someone else has (FR-OUT-12). Names the check-out it replaces, so replay knows it
 * is not a conflict. Carries the reservation like a check-out does: gear never returned from the
 * last trip is packed for this one by transfer (FR-RES-22).
 */
export async function transfer(store: Store, itemId: string, options: MoveOptions = {}) {
  const it = current(store, itemId);
  if (it.retired) throw new Error("retired items cannot be checked out");
  if (it.merged_into) throw new Error("merged into another item");
  const previous = it.movement as Movement | undefined;
  if (it.status !== "out" || !previous) throw new Error("not out; check it out instead");
  return move(
    store,
    itemId,
    "checked_out",
    {
      holder_id: actor(store),
      event: options.event?.trim() || null,
      supersedes: previous.id,
      reservation_id: options.reservation_id ?? null,
    },
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

/** Gone from the item, still in the log (FR-OUT-21). */
export const deleteNote = (store: Store, itemId: string, noteId: string) =>
  notes.deleteNote(store, onItem(itemId), noteId);

/**
 * The event a movement was recorded under, put right (FR-RES-17), and the reservation it now
 * packs, if any. Appended, the same shape as a note correction: the movement itself is never
 * rewritten (FR-OUT-16).
 */
export async function correctEvent(
  store: Store,
  itemId: string,
  movementId: string,
  event: string | null,
  reservationId?: string | null,
) {
  const it = item(store.state, itemId);
  if (!it) throw new Error("no such item");
  return store.record({
    entity_type: "item",
    entity_id: itemId,
    type: "event_corrected",
    actor_id: actor(store),
    payload: { movement_id: movementId, event: event?.trim() || null, reservation_id: reservationId ?? null },
  });
}

export interface HistoryEntry {
  id: string;
  type: "checked_out" | "checked_in" | "recounted";
  actor_id: string;
  holder_id: string | null;
  event: string | null;
  supersedes: string | null;
  at: number;
  notes: Note[];
  /** Set on a pool's line (FR-INV-34, FR-INV-35): how many this checked-out or checked-in carried, or a recount's new count. */
  count?: number;
  /** Set only on a "recounted" line (FR-INV-35): why. */
  reason?: string | null;
}

/**
 * The item's movements, newest first, each with its notes (FR-INV-09). A merged
 * duplicate's movements belong to the survivor (FR-INV-13). A pool's recounts
 * are here too, alongside its checked-out and checked-in lines (FR-INV-35).
 */
export function history(log: Log, itemId: string): HistoryEntry[] {
  const notes = aliases(log.state, itemId).flatMap((id) => (item(log.state, id)?.notes ?? []) as Note[]);
  const events = aliases(log.state, itemId)
    .flatMap((id) => log.eventsFor("item", id))
    .sort(replayOrder);
  // The last correction wins, the same rule replay uses for the current movement (FR-RES-17).
  const corrected = new Map<string, string | null>();
  for (const e of events) {
    if (e.type === "event_corrected") {
      corrected.set(e.payload.movement_id as string, (e.payload.event as string | null) ?? null);
    }
  }
  return events
    .filter((e) => e.type === "checked_out" || e.type === "checked_in" || e.type === "recounted")
    .map((e) => ({
      id: e.id,
      type: e.type as HistoryEntry["type"],
      actor_id: e.actor_id,
      holder_id: (e.payload.holder_id as string | undefined) ?? null,
      event: corrected.has(e.id) ? corrected.get(e.id)! : (e.payload.event as string | undefined) ?? null,
      supersedes: (e.payload.supersedes as string | undefined) ?? null,
      at: e.effective_at,
      notes: notes.filter((n) => n.movement_id === e.id),
      count: (e.payload.count as number | undefined) ?? undefined,
      reason: (e.payload.reason as string | undefined) ?? null,
    }))
    .reverse();
}
