/**
 * Replay: events in, current state out. Pure.
 *
 * This runs twice, here and in Python on the server (src/gear_tracker/replay.py),
 * and the two must agree. The shared vectors under vectors/replay/ are the
 * contract (NFR-MAINT-04). Change a rule here, change the vectors, and the other
 * side fails until it catches up.
 */

export type Fields = Record<string, unknown>;
/** entity_type -> entity_id -> fields */
export type State = Record<string, Record<string, Fields>>;

// --- pools (FR-INV-34) -------------------------------------------------------------------
//
// A pool is an item with `generic: true` and `pool: true`, `created` with an integer `quantity`
// (>= 0). It has no units (the server refuses that); it may carry a code, bound to the container
// that holds the stack rather than to a labelled unit (FR-TAG-15). Its `status` stays "in" and
// `holder_id` null forever; the counts below carry the truth. Owned is `pool_in` plus the sum
// of every count in `pool_out`; it is never stored. Read both through `poolCounts` and
// `isPool` in inventory.ts, not directly.
//
// Derived fields, never set by a device:
//   pool_in           number                          what is on the shelf right now
//   pool_out          Record<holder_id, number>       what each holder has; a holder back at zero is removed
//   pool_reservations Record<reservation_id, number>  how many went out for each reservation, ever
//                                                      (FR-RES-13). A checked_out that carries a
//                                                      reservation_id adds to it, event_corrected moves
//                                                      a lot's count, and a return never reduces it. Older
//                                                      app builds read it for progress; this one counts the
//                                                      lots (poolPacked), so it is kept for them only. Keyed
//                                                      by reservation id, not event name, so a later
//                                                      reservation reusing an event name starts at zero.
//   pool_lots         Record<holder_id, PoolLot[]>    which check-outs each holder's count came from, oldest
//                                                      first, so a count can be read under its event. Lot ids
//                                                      are unique. `cleaning_id` is the cleaning_started that
//                                                      sent the lot home; one send-home can span several lots.
//
// Events, on the pool's own entity (mirrored in views.py's `pool_counts`, `is_pool`):
//   created    {quantity}                            pool_in = quantity, pool_out = {}, pool_reservations = {}
//   checked_out {holder_id, count, event?,           pool_out[holder_id] += count; pool_in -= count,
//                reservation_id?}                     clamped at 0 (an overdraw warns, never blocks:
//                                                      FR-OUT-22). No supersedes, no conflict rule: counts
//                                                      from any device just add, whatever the order
//                                                      (FR-OUT-24). A reservation_id also adds count to
//                                                      pool_reservations[reservation_id]; with none, it
//                                                      adds to nothing. Adds a lot under the holder.
//   checked_in  {holder_id?, count}          holder defaults to the actor; pool_out[holder] =
//                                             max(0, pool_out[holder] - count), removed at 0;
//                                             pool_in += count (FR-OUT-23). A return says nothing of
//                                             which event, so it comes off the holder's oldest lots.
//   event_corrected {movement_id, event?,    a lot from that check-out moves to the new event, and its
//                    reservation_id?}         count moves between pool_reservations entries.
//   cleaner_corrected {movement_id, cleaner}  every lot, and the item's movement, that still has a cleaner and
//                                             whose `cleaning_id`, else `id`, is `movement_id` takes the new
//                                             cleaner. Gear that has come back is ignored. A checked_out with
//                                             a cleaner adds it to its lot; a checked_in with one comes off
//                                             that cleaner's lots first (returnLots).
//   cleaning_started {cleaner, count?,        `count` of that holder's lots not at a cleaner go home with
//                     holder_id?,              `cleaner` (FR-OUT-46); counts, holders and events do not change
//                     movement_id?}            (startCleaning). With no `count`, a single item that is out
//                                              takes `cleaner` and `cleaning_id` on its movement if that
//                                              movement is `movement_id`; its holder, event, reservation and
//                                              `since` stay. Otherwise ignored.
//   checked_out superseding a movement that has a cleaner, with none of its own, keeps that cleaner and
//   `cleaning_id` (a transfer of gear at a cleaner's, FR-OUT-46).
//   cleaning_ended {cleaner?, count?,         cleaned gear is back with its Scouter (FR-OUT-51). A single
//                   holder_id?}                item's movement loses its cleaner and cleaning_id. A pool's `count` of
//                                             that holder's lots under `cleaner` lose it (endCleaning).
//   recounted   {count, reason?}             pool_in = count. pool_out is untouched (FR-INV-35);
//                                             anyone signed in may record one.
//
// A pool's `movement` is kept up to date like any item's, with `count` added (see `movement`),
// so the item's History can read "Alice checked out 10" straight off the log.

export interface ReplayEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  type: string;
  actor_id: string;
  device_id: string;
  device_seq: number;
  effective_at: number;
  payload: Record<string, unknown>;
}

/** So many of a generic item on a reservation's gear list (FR-RES-13). */
export interface GenericLine {
  item_id: string;
  quantity: number;
}

export interface Note {
  id: string;
  text: string;
  actor_id: string;
  at: number;
  movement_id?: string;
}

export interface Movement {
  id: string;
  type: string;
  holder_id: unknown;
  event: unknown;
  /** The reservation this movement packs, or null (FR-RES-13). Only this counts toward its progress. */
  reservation_id: unknown;
  actor_id: string;
  device_id: string;
  at: number;
  /** Set only for a pool (FR-OUT-22, FR-OUT-23): how many this movement carried. */
  count?: number;
  /** Set when the gear went home to be cleaned (FR-OUT-46): who took it. */
  cleaner?: string;
  /** The cleaning_started that sent a single item home. */
  cleaning_id?: string;
}

/** A pool's out side: how many one holder has (FR-INV-36). */
export type PoolOut = Record<string, number>;

/** A pool's per-reservation out total (FR-RES-13): how many went out for each reservation, ever. */
export type PoolReservations = Record<string, number>;

/** What is left of one check-out of a pool, still with its holder. `id` is the check-out's. */
export interface PoolLot {
  id: string;
  count: number;
  event: string | null;
  reservation_id: string | null;
  at: number;
  /** Who took this lot home to clean (FR-OUT-46); absent on an ordinary check-out. */
  cleaner?: string;
  /** The cleaning_started that sent this lot home; one send-home can span several lots. */
  cleaning_id?: string;
}

export type PoolLots = Record<string, PoolLot[]>;

/** The newest lots that add up to `count`: a return comes off the oldest. */
export function keepNewest(lots: PoolLot[], count: number): PoolLot[] {
  const kept: PoolLot[] = [];
  let left = count;
  for (const lot of [...lots].reverse()) {
    if (left <= 0) break;
    const n = Math.min(lot.count, left);
    kept.unshift({ ...lot, count: n });
    left -= n;
  }
  return kept;
}

/** What makes two cleaner names the same: case and spacing aside. Mirrors cleaner_key in replay.py. */
export function cleanerKey(name: string): string {
  return name
    .split(/[ \t\n\r]+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * A holder's lots after `count` of their `before` are returned (FR-OUT-47). Mirrors return_lots in
 * replay.py. A return naming a cleaner comes off that cleaner's lots first. What is left to take, and
 * any return that names nobody, comes off the part no lot explains, then the ordinary lots, then the
 * cleaning lots: each oldest first, so a plain return never swallows a family's lot.
 */
export function returnLots(lots: PoolLot[], before: number, count: number, cleaner?: string | null): PoolLot[] {
  let left = Math.min(count, before);
  const kept = lots.map((l) => ({ ...l }));
  const take = (match: (l: PoolLot) => boolean) => {
    for (const lot of kept) {
      if (left > 0 && match(lot)) {
        const n = Math.min(lot.count, left);
        lot.count -= n;
        left -= n;
      }
    }
  };
  if (cleaner) {
    const key = cleanerKey(cleaner);
    take((l) => !!l.cleaner && cleanerKey(l.cleaner) === key);
  }
  left -= Math.min(left, Math.max(0, before - lots.reduce((n, l) => n + l.count, 0)));
  take((l) => !l.cleaner);
  take(() => true);
  return kept.filter((l) => l.count > 0);
}

/**
 * A holder's lots after `count` of those not yet at a cleaner go home with `cleaner` (FR-OUT-46). Mirrors
 * start_cleaning in replay.py. Oldest first. Every lot that goes gets `cleaning_id` `newId`, so a later correction of the
 * name, which names this event, finds them all. A lot that goes whole keeps its id; a part of one takes `newId`, so lot
 * ids stay unique.
 */
export function startCleaning(lots: PoolLot[], count: number, cleaner: string, newId: string): PoolLot[] {
  let left = count;
  const out: PoolLot[] = [];
  for (const lot of lots) {
    if (left > 0 && !lot.cleaner) {
      const n = Math.min(lot.count, left);
      left -= n;
      if (n === lot.count) out.push({ ...lot, cleaner, cleaning_id: newId });
      else {
        out.push({ ...lot, count: lot.count - n });
        out.push({ ...lot, id: newId, count: n, cleaner, cleaning_id: newId });
      }
    } else out.push({ ...lot });
  }
  return out;
}

/** A holder's lots after `count` of those under `cleaner` come back (FR-OUT-51). Mirrors end_cleaning in replay.py. */
export function endCleaning(
  lots: PoolLot[],
  count: number,
  cleaner: string | null | undefined,
  newId: string,
): PoolLot[] {
  if (!cleaner) return lots.map((l) => ({ ...l }));
  const key = cleanerKey(cleaner);
  let left = count;
  const out: PoolLot[] = [];
  for (const lot of lots) {
    if (left > 0 && lot.cleaner && cleanerKey(lot.cleaner) === key) {
      const n = Math.min(lot.count, left);
      left -= n;
      const { cleaner: _gone, cleaning_id: _sent, ...back } = lot;
      if (n === lot.count) out.push(back);
      else {
        out.push({ ...lot, count: lot.count - n });
        out.push({ ...back, id: newId, count: n });
      }
    } else out.push({ ...lot });
  }
  return out;
}

/** A file on the server. Never the bytes: those are fetched when online (FR-INV-11). */
export interface Photo {
  id: string;
  content_type: string;
  size: number;
  actor_id: string;
  at: number;
}

export class UnknownEventType extends Error {}

/**
 * Every event type `apply()` handles. A build too old for a type on the log skips events of
 * that type instead of crashing (store.ts, `recompute` and `trim`); `apply()` still throws on
 * one of these, kept only so the twin Python replay stays in step.
 */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "created",
  "field_changed",
  "item_added",
  "item_removed",
  "quantity_changed",
  "event_corrected",
  "cleaner_corrected",
  "cleaning_started",
  "cleaning_ended",
  "note_added",
  "note_corrected",
  "note_deleted",
  "checked_out",
  "checked_in",
  "recounted",
  "photo_added",
  "photo_removed",
  "code_bound",
  "code_released",
]);

/** (effective_at, device_id, device_seq): the one order every replay uses. */
export function replayOrder(a: ReplayEvent, b: ReplayEvent): number {
  if (a.effective_at !== b.effective_at) return a.effective_at - b.effective_at;
  if (a.device_id !== b.device_id) return a.device_id < b.device_id ? -1 : 1;
  return a.device_seq - b.device_seq;
}

/**
 * Build state, from scratch or on top of a snapshot. Input order does not
 * matter; replay order does. The base is not changed.
 */
export function replay(events: Iterable<ReplayEvent>, base?: State): State {
  const state: State = base ? structuredClone(base) : {};
  for (const event of [...events].sort(replayOrder)) {
    const entities = (state[event.entity_type] ??= {});
    const entity = (entities[event.entity_id] ??= {});
    apply(entity, event);
  }
  return state;
}

/** One event onto one entity's fields, in place. */
export function apply(entity: Fields, event: ReplayEvent): void {
  const p = event.payload;
  switch (event.type) {
    case "created":
      Object.assign(entity, p);
      entity.added_at = event.effective_at;
      entity.modified_at = event.effective_at;
      // A generic item is a name several things share; it never moves, so it has no status (FR-INV-21).
      if (event.entity_type === "item" && !p.generic) {
        if (!("status" in entity)) entity.status = "in";
        if (!("holder_id" in entity)) entity.holder_id = null;
      }
      // A pool is a generic too, but it stays "in" and unheld forever; the counts carry the truth (FR-INV-34).
      if (event.entity_type === "item" && p.pool) {
        if (!("status" in entity)) entity.status = "in";
        if (!("holder_id" in entity)) entity.holder_id = null;
        entity.pool_in = (p.quantity as number | undefined) ?? 0;
        entity.pool_out = {};
        entity.pool_reservations = {};
      }
      if (event.entity_type === "repair") {
        entity.raised_by = event.actor_id;
        if (!("state" in entity)) entity.state = "open";
      }
      if (event.entity_type === "reservation") {
        entity.created_by = event.actor_id;
      }
      break;
    case "field_changed":
      // Modified means the entity's own fields (FR-INV-03). Movements and notes do not count.
      entity[p.field as string] = p.value;
      entity.modified_at = event.effective_at;
      // When a user is deactivated, remember when (FR-USR-20); a reactivation clears it.
      if (event.entity_type === "user" && p.field === "active") {
        entity.deactivated_at = p.value === false ? event.effective_at : null;
      }
      break;
    case "item_added": {
      // The gear list is edited one line at a time, so two devices adding an
      // extra offline both land (FR-RES-07). A new array each time: the one
      // `created` put here is the event's own payload.
      const items = (entity.items ?? []) as string[];
      if (!items.includes(p.item_id as string)) entity.items = [...items, p.item_id as string];
      entity.modified_at = event.effective_at;
      break;
    }
    case "item_removed":
      entity.items = ((entity.items ?? []) as string[]).filter((id) => id !== p.item_id);
      entity.modified_at = event.effective_at;
      break;
    case "quantity_changed": {
      // How many of a generic the reservation wants (FR-RES-13). Zero drops the line.
      const lines = (entity.generics ?? []) as GenericLine[];
      const itemId = p.item_id as string;
      const quantity = p.quantity as number;
      if (quantity === 0) entity.generics = lines.filter((g) => g.item_id !== itemId);
      else if (lines.some((g) => g.item_id === itemId))
        entity.generics = lines.map((g) => (g.item_id === itemId ? { ...g, quantity } : g));
      else entity.generics = [...lines, { item_id: itemId, quantity }];
      entity.modified_at = event.effective_at;
      break;
    }
    case "event_corrected": {
      // The movement stands in the log; only the event it is read under moves
      // (FR-RES-17, as FR-OUT-16). Older movements are corrected in the log too;
      // state carries the last one, which is what "out under" means.
      const current = entity.movement as Movement | null | undefined;
      if (current && current.id === p.movement_id) {
        current.event = p.event ?? null;
        current.reservation_id = p.reservation_id ?? null;
      }
      correctLot(entity, p);
      break;
    }
    case "cleaner_corrected": {
      // As event_corrected: the check-out stands; only the name it is read under moves (FR-OUT-50).
      // Gear that has come back has no cleaner to correct.
      const current = entity.movement as Movement | null | undefined;
      if (current?.cleaner && names(current, p.movement_id as string)) current.cleaner = p.cleaner as string;
      const lots = entity.pool_lots as PoolLots | undefined;
      if (lots) {
        const fixedLots: PoolLots = {};
        for (const [holderId, list] of Object.entries(lots)) {
          fixedLots[holderId] = list.map((l) =>
            l.cleaner && names(l, p.movement_id as string) ? { ...l, cleaner: p.cleaner as string } : l,
          );
        }
        entity.pool_lots = fixedLots;
      }
      break;
    }
    case "cleaning_started": {
      if (p.count == null) {
        // Still out to the same holder under the check-out it names; only the cleaner is added.
        const current = entity.movement as Movement | null | undefined;
        if (entity.status === "out" && current && current.id === p.movement_id) {
          current.cleaner = p.cleaner as string;
          current.cleaning_id = event.id;
        }
        break;
      }
      const holderId = (p.holder_id as string | undefined) ?? event.actor_id;
      const lots = (entity.pool_lots ?? {}) as PoolLots;
      if (lots[holderId]) {
        entity.pool_lots = {
          ...lots,
          [holderId]: startCleaning(lots[holderId], p.count as number, p.cleaner as string, event.id),
        };
      }
      break;
    }
    case "cleaning_ended": {
      if (p.count != null) {
        const holderId = (p.holder_id as string | undefined) ?? event.actor_id;
        const lots = (entity.pool_lots ?? {}) as PoolLots;
        if (lots[holderId]) {
          entity.pool_lots = {
            ...lots,
            [holderId]: endCleaning(lots[holderId], p.count as number, p.cleaner as string | undefined, event.id),
          };
        }
      } else {
        const current = entity.movement as Movement | null | undefined;
        if (entity.status === "out" && current) {
          delete current.cleaner;
          delete current.cleaning_id;
        }
      }
      break;
    }
    case "note_added": {
      const note: Note = { id: event.id, text: p.text as string, actor_id: event.actor_id, at: event.effective_at };
      if (p.movement_id != null) note.movement_id = p.movement_id as string;
      notes(entity).push(note);
      break;
    }
    case "note_corrected":
      // The original event stands in the log; only the rendered text moves.
      for (const note of notes(entity)) {
        if (note.id === p.note_id) note.text = p.text as string;
      }
      break;
    case "note_deleted":
      // The note stops being shown; the log keeps it, with who wrote it and when (FR-OUT-21).
      entity.notes = notes(entity).filter((n) => n.id !== p.note_id);
      break;
    case "checked_out": {
      if (p.count != null) {
        // A pool moves by count, not by holder (FR-OUT-22): several people may have some out at once,
        // counts from any device just add, and there is no conflict rule (FR-OUT-24).
        const holderId = p.holder_id as string;
        const count = p.count as number;
        const poolOut = { ...((entity.pool_out ?? {}) as PoolOut) };
        poolOut[holderId] = (poolOut[holderId] ?? 0) + count;
        entity.pool_out = poolOut;
        entity.pool_in = Math.max(0, ((entity.pool_in as number | undefined) ?? 0) - count);
        if (p.reservation_id != null) {
          const poolReservations = { ...((entity.pool_reservations ?? {}) as PoolReservations) };
          const reservationId = p.reservation_id as string;
          poolReservations[reservationId] = (poolReservations[reservationId] ?? 0) + count;
          entity.pool_reservations = poolReservations;
        }
        const lots = { ...((entity.pool_lots ?? {}) as PoolLots) };
        const lot: PoolLot = {
          id: event.id,
          count,
          event: (p.event as string | null | undefined) ?? null,
          reservation_id: (p.reservation_id as string | null | undefined) ?? null,
          at: event.effective_at,
        };
        if (p.cleaner) lot.cleaner = p.cleaner as string;
        lots[holderId] = [...(lots[holderId] ?? []), lot];
        entity.pool_lots = lots;
        entity.movement = movement(event);
        break;
      }
      // Two check-outs from different devices with no check-in between:
      // the machine picks the later one and queues both (FR-OFF-10).
      // Unless the later one says which check-out it replaces: that is a
      // transfer, made by someone who saw the first (FR-OUT-12).
      const previous = entity.movement as Movement | null | undefined;
      if (
        previous &&
        previous.type === "checked_out" &&
        previous.device_id !== event.device_id &&
        p.supersedes !== previous.id
      ) {
        ((entity.conflicts ??= []) as unknown[]).push({
          kind: "double_checkout",
          events: [previous, movement(event)],
        });
      }
      entity.status = "out";
      entity.holder_id = p.holder_id;
      entity.since = event.effective_at;
      entity.movement = movement(event);
      // A transfer made without seeing the send-home keeps the gear at the cleaner's.
      if (previous?.cleaner && p.supersedes === previous.id && !p.cleaner) {
        const kept = entity.movement as Movement;
        kept.cleaner = previous.cleaner;
        kept.cleaning_id = previous.cleaning_id ?? previous.id;
      }
      break;
    }
    case "checked_in": {
      if (p.count != null) {
        // The count offered is what the holder has out; returning fewer leaves the rest against
        // them (FR-OUT-23). The holder defaults to whoever is returning it.
        const holderId = (p.holder_id as string | undefined) ?? event.actor_id;
        const count = p.count as number;
        const poolOut = { ...((entity.pool_out ?? {}) as PoolOut) };
        const before = poolOut[holderId] ?? 0;
        const remaining = Math.max(0, before - count);
        if (remaining) poolOut[holderId] = remaining;
        else delete poolOut[holderId];
        entity.pool_out = poolOut;
        entity.pool_in = ((entity.pool_in as number | undefined) ?? 0) + count;
        const lots = { ...((entity.pool_lots ?? {}) as PoolLots) };
        if (remaining)
          lots[holderId] = returnLots(lots[holderId] ?? [], before, count, p.cleaner as string | undefined);
        else delete lots[holderId];
        entity.pool_lots = lots;
        const m = movement(event);
        m.holder_id = holderId;
        entity.movement = m;
        break;
      }
      entity.status = "in";
      entity.holder_id = null;
      entity.since = event.effective_at;
      entity.movement = movement(event);
      break;
    }
    case "recounted":
      // How many are in right now; what is already out is untouched (FR-INV-35).
      entity.pool_in = p.count as number;
      break;
    case "photo_added":
      // The file is on the server; this is what a device knows about it (FR-INV-11).
      photos(entity).push({
        id: p.photo_id as string,
        content_type: p.content_type as string,
        size: p.size as number,
        actor_id: event.actor_id,
        at: event.effective_at,
      });
      break;
    case "photo_removed":
      // The file stays on disk; the log says it is no longer shown.
      entity.photos = photos(entity).filter((ph) => ph.id !== p.photo_id);
      break;
    case "code_bound":
      // A code binds once. Whether it is the item's current code or a replaced
      // one is a question about the item's other codes, answered by whoever asks.
      entity.item_id = p.item_id;
      entity.bound_at = event.effective_at;
      break;
    case "code_released":
      // Deliberate, unlike a replace (FR-TAG-05): the code goes back to
      // unassigned, so scanning it offers a new item or a bind (FR-TAG-07).
      entity.item_id = null;
      break;
    default:
      throw new UnknownEventType(event.type);
  }
}

function notes(entity: Fields): Note[] {
  return (entity.notes ??= []) as Note[];
}

function photos(entity: Fields): Photo[] {
  return (entity.photos ??= []) as Photo[];
}

const names = (thing: { id: string; cleaning_id?: string }, movementId: string) =>
  (thing.cleaning_id ?? thing.id) === movementId;

function correctLot(entity: Fields, p: Fields): void {
  const lots = entity.pool_lots as PoolLots | undefined;
  if (!lots) return;
  const next = (p.reservation_id as string | null | undefined) ?? null;
  for (const [holderId, list] of Object.entries(lots)) {
    const lot = list.find((l) => l.id === p.movement_id);
    if (!lot) continue;
    if (lot.reservation_id !== next) {
      const totals = { ...((entity.pool_reservations ?? {}) as PoolReservations) };
      if (lot.reservation_id !== null) {
        const left = (totals[lot.reservation_id] ?? 0) - lot.count;
        if (left > 0) totals[lot.reservation_id] = left;
        else delete totals[lot.reservation_id];
      }
      if (next !== null) totals[next] = (totals[next] ?? 0) + lot.count;
      entity.pool_reservations = totals;
    }
    const fixed = { ...lot, event: (p.event as string | null | undefined) ?? null, reservation_id: next };
    entity.pool_lots = { ...lots, [holderId]: list.map((l) => (l === lot ? fixed : l)) };
    return;
  }
}

function movement(event: ReplayEvent): Movement {
  const m: Movement = {
    id: event.id,
    type: event.type,
    holder_id: event.payload.holder_id ?? null,
    event: event.payload.event ?? null,
    reservation_id: event.payload.reservation_id ?? null,
    actor_id: event.actor_id,
    device_id: event.device_id,
    at: event.effective_at,
  };
  if (event.payload.count != null) m.count = event.payload.count as number;
  if (event.payload.cleaner) m.cleaner = event.payload.cleaner as string;
  return m;
}
