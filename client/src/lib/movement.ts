/**
 * Check-out, check-in, transfer, and the notes that ride on them. Each is one
 * or two events on the store. Nothing here talks to the server; the caller
 * syncs afterwards (FR-OFF-03).
 */
import { seen } from "./actions";
import { aliases, isPool, item, type Item, poolCounts } from "./inventory";
import * as notes from "./notes";
import type { Log } from "./record";
import { eventNameKey, tidyName } from "./calendar";
import { type Movement, type Note, type ReplayEvent, replayOrder, type State } from "./replay";
import { eventAsked, setSessionEvent } from "./session";
import type { MoveSession, Store } from "./store";

export interface MoveOptions {
  /** The session's event name (FR-OUT-05). */
  event?: string;
  /** The reservation this check-out packs (FR-RES-13). Only a check-out that carries it counts
   * toward that reservation's progress; the event name alone is not enough (it repeats year to year). */
  reservation_id?: string;
  /** A note on this movement (FR-OUT-15). */
  note?: string;
  /** Made while packing a reservation, so it leaves the plain session's clock alone (FR-RES-25). */
  packing?: boolean;
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

/** Every move goes through here. One given `session` keeps a running plain session going (FR-OUT-38). */
async function move(
  store: Store,
  itemId: string,
  type: string,
  payload: Record<string, unknown>,
  note?: string,
  session?: MoveSession,
) {
  const movement = await store.record(
    { entity_type: "item", entity_id: itemId, type, actor_id: actor(store), payload },
    session,
  );
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
    options.packing ? undefined : { event: options.event?.trim() || null },
  );
}

/** Anyone can bring anything back (FR-OUT-08). */
export async function checkIn(store: Store, itemId: string, options: MoveOptions = {}) {
  const it = current(store, itemId);
  if (it.status !== "out") throw new Error("already in");
  const movement = await move(store, itemId, "checked_in", {}, options.note, options.packing ? undefined : {});
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
  packing?: boolean;
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
    options.packing ? undefined : { event: options.event?.trim() || null },
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
  return move(store, itemId, "checked_in", payload, options.note, options.packing ? undefined : {});
}

/** How many are in right now, with a reason (FR-INV-35). What is already out is untouched; anyone signed in may record one. */
export async function recount(store: Store, itemId: string, count: number, reason: string) {
  poolItem(store, itemId);
  if (!Number.isInteger(count) || count < 0) throw new Error("pick a count of zero or more");
  const why = reason.trim();
  if (!why) throw new Error("say why");
  return move(store, itemId, "recounted", { count, reason: why });
}

export interface TransferOptions extends MoveOptions {
  /** Who gets it (FR-OUT-26). Defaults to whoever is signed in: a take-over (FR-OUT-12). */
  to?: string;
}

/**
 * Move something that is out to a new holder: the signed-in person by default (FR-OUT-12), or
 * another member (FR-OUT-26). Names the check-out it replaces, so replay knows it is not a
 * conflict. Carries the reservation like a check-out does: gear never returned from the last trip
 * is packed for this one by transfer (FR-RES-22).
 */
export async function transfer(store: Store, itemId: string, options: TransferOptions = {}) {
  const it = current(store, itemId);
  if (it.retired) throw new Error("retired items cannot be checked out");
  if (it.merged_into) throw new Error("merged into another item");
  const previous = it.movement as Movement | undefined;
  if (it.status !== "out" || !previous) throw new Error("not out; check it out instead");
  const to = options.to ?? actor(store);
  if (to === it.holder_id) throw new Error("they already have it");
  return move(
    store,
    itemId,
    "checked_out",
    {
      holder_id: to,
      event: options.event?.trim() || null,
      supersedes: previous.id,
      reservation_id: options.reservation_id ?? null,
    },
    options.note,
    options.packing ? undefined : { event: options.event?.trim() || null },
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

/** What a movement is read under now: the event, the reservation it packs, and since when. */
export interface Reading {
  event: string | null;
  reservation_id: string | null;
  /** When it took this reading: the correction's time, or the movement's own. */
  at: number;
}

/**
 * Each corrected movement's reading: its last `event_corrected` in replay order wins, the rule
 * replay uses for the current movement (FR-RES-17).
 */
export function corrections(events: ReplayEvent[]): Map<string, Reading> {
  const last = new Map<string, Reading>();
  for (const e of events.filter((e) => e.type === "event_corrected").sort(replayOrder)) {
    last.set(e.payload.movement_id as string, {
      event: (e.payload.event as string | null | undefined) ?? null,
      reservation_id: (e.payload.reservation_id as string | null | undefined) ?? null,
      at: e.effective_at,
    });
  }
  return last;
}

const CORRECTIONS = "corrections";

/** Every correction this device holds, worked out once per change to the store. */
export const knownCorrections = (store: Store) => store.memo(CORRECTIONS, () => corrections(store.known));

/** A movement's reading: its last correction, else what it recorded. */
export function reading(e: ReplayEvent, corrected: Map<string, Reading>): Reading {
  return (
    corrected.get(e.id) ?? {
      event: (e.payload.event as string | null | undefined) ?? null,
      reservation_id: (e.payload.reservation_id as string | null | undefined) ?? null,
      at: e.effective_at,
    }
  );
}

/**
 * Event names used before, most recent first, one per name, case and spacing aside (FR-RES-27):
 * reservations not cancelled, the event each item is out under, and each check-out in `log` as it
 * now reads (`corrected`). A corrected name ranks by the correction's time; one corrected away is
 * not offered again.
 */
export function usedEventNames(state: State, log: ReplayEvent[], corrected: Map<string, Reading>): string[] {
  const named: [string, number][] = [];
  const add = (name: unknown, at: unknown) => {
    if (typeof name === "string" && name.trim()) named.push([tidyName(name), typeof at === "number" ? at : 0]);
  };
  for (const r of Object.values(state.reservation ?? {})) {
    if (!r.cancelled) add(r.event, r.modified_at ?? r.added_at);
  }
  for (const it of Object.values(state.item ?? {})) {
    const m = it.movement as Movement | null | undefined;
    if (m) add(m.event, corrected.get(m.id)?.at ?? m.at);
  }
  for (const e of log) {
    if (e.type !== "checked_out") continue;
    const r = reading(e, corrected);
    add(r.event, r.at);
  }
  const names = new Map<string, string>();
  for (const [name] of named.sort((a, b) => b[1] - a[1])) {
    if (!names.has(eventNameKey(name))) names.set(eventNameKey(name), name);
  }
  return [...names.values()];
}

const USED_NAMES = "used event names";

/** The names used before on this device (FR-RES-27), worked out once per change to the store. */
export const knownEventNames = (store: Store) =>
  store.memo(USED_NAMES, () => usedEventNames(store.state, store.known, knownCorrections(store)));

/** Names compared as the same event, case and spacing aside; blank is No event. */
const sameKey = (name: string | null | undefined) => eventNameKey(name ?? "");

/** One move a plain session made (FR-OUT-40). */
export interface SessionMove {
  itemId: string;
  movementId: string;
}

const SESSION_MOVES = "session moves";

/**
 * The moves an unanswered change of the plain session's event offers to correct (FR-OUT-40): every
 * check-out and transfer this device recorded for the signed-in person since the session started,
 * still read under one of the events it had before the change and packing no reservation. A move
 * corrected since to anything else, here or elsewhere, drops out; one returned since stays, since its
 * event is still history. Nothing once the session has ended, or for one an older build started.
 * The start is the device clock, which a sync never moves: only effective_at carries the offset.
 */
export function sessionMoves(store: Store): SessionMove[] {
  const { meta } = store;
  const started = meta.session_started_at;
  const prior = meta.session_prior_events;
  if (!meta.user || started === undefined || !prior?.length || !eventAsked(meta, store.now())) return [];
  return store.memo(SESSION_MOVES, () => {
    const now = sameKey(meta.session_event);
    const before = new Set(prior.map(sameKey));
    const corrected = knownCorrections(store);
    return store
      .eventsBy(meta.user!.id)
      .filter((e) => e.type === "checked_out" && e.device_id === meta.device_id && e.occurred_at >= started)
      .filter((e) => {
        const r = reading(e, corrected);
        return r.reservation_id == null && sameKey(r.event) !== now && before.has(sameKey(r.event));
      })
      .sort(replayOrder)
      .map((e) => ({ itemId: e.entity_id, movementId: e.id }));
  });
}

/**
 * Change the running session's event from the Scan screen (FR-OUT-40). Keeps its start, and the
 * event it replaces while that leaves moves to offer; with none, there is no question to follow.
 */
export async function changeSessionEvent(store: Store, name: string | undefined) {
  await setSessionEvent(store, name, true);
  if (store.meta.session_prior_events && sessionMoves(store).length === 0) {
    await store.setMeta({ session_prior_events: undefined });
  }
}

/**
 * Put the session's earlier moves under its event, one appended correction each, and close the
 * question (FR-OUT-40). Found afresh, so a second tap or a retry corrects only what is still left.
 * Only moves that pack nothing are offered, so no reservation link is written over. Refused once
 * the session has ended.
 */
export async function correctSessionMoves(store: Store) {
  // An ended session's question is gone from the screen; a tap that raced the end changes nothing.
  if (!eventAsked(store.meta, store.now())) throw new Error("The session has ended. Nothing was changed.");
  const event = store.meta.session_event ?? null;
  for (const m of sessionMoves(store)) await correctEvent(store, m.itemId, m.movementId, event);
  await store.setMeta({ session_prior_events: undefined });
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
  const corrected = corrections(events);
  return events
    .filter((e) => e.type === "checked_out" || e.type === "checked_in" || e.type === "recounted")
    .map((e) => ({
      id: e.id,
      type: e.type as HistoryEntry["type"],
      actor_id: e.actor_id,
      holder_id: (e.payload.holder_id as string | undefined) ?? null,
      event: reading(e, corrected).event,
      supersedes: (e.payload.supersedes as string | undefined) ?? null,
      at: e.effective_at,
      notes: notes.filter((n) => n.movement_id === e.id),
      count: (e.payload.count as number | undefined) ?? undefined,
      reason: (e.payload.reason as string | undefined) ?? null,
    }))
    .reverse();
}
