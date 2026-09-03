/**
 * Reservations: planning a camp, then packing for it (FR-RES-01, FR-RES-02).
 *
 * A reservation is an entity on the log: created whole, its event and dates
 * edited by field_changed, cancelled by a field. The gear list is edited one
 * line at a time, never as a whole list, so two devices each adding an extra
 * offline both land (FR-RES-07). Packing progress is not recorded anywhere. An
 * item is ticked off when it is out under the reservation's event, which replay
 * already knows, so two devices packing one camp agree after a sync and a reload
 * loses nothing.
 */
import {
  displayName,
  homeLabel,
  isPool,
  type Item,
  item,
  movable,
  nameOf,
  poolCounts,
  resolveItem,
  unitsOf,
} from "./inventory";
import { correctEvent } from "./movement";
import type { Fields, Movement, PoolEvents, State } from "./replay";
import type { Store } from "./store";
import { localDate } from "./time";
import { newUlid } from "./ulid";

/** So many of a generic item, in place of named units (FR-RES-13). */
export interface GenericQuantity {
  item_id: string;
  quantity: number;
}

export interface Reservation {
  id: string;
  event: string;
  /** Calendar days, "YYYY-MM-DD". Text order is date order. */
  starts: string;
  ends: string;
  items: string[];
  generics: GenericQuantity[];
  cancelled?: boolean;
  added_at?: number;
  modified_at?: number;
  /** Who made it, set at replay from the creating event's actor (FR-RES-18). Absent on an old reservation. */
  created_by?: string;
}

export type ReservationInput = Pick<Reservation, "event" | "starts" | "ends" | "items" | "generics">;

/** The calendar day where the gear is, not where the server is (NFR-DATA-12). */
export const todayIso = (now: number, timeZone?: string): string => localDate(now, timeZone);

function withId(table: Record<string, Fields> | undefined): Reservation[] {
  return Object.entries(table ?? {}).map(([id, fields]) => ({ id, ...fields }) as Reservation);
}

const byStart = (a: Reservation, b: Reservation) => a.starts.localeCompare(b.starts) || a.event.localeCompare(b.event);

/** Every reservation not cancelled. */
export const reservations = (state: State): Reservation[] =>
  withId(state.reservation)
    .filter((r) => !r.cancelled)
    .sort(byStart);

export const reservation = (state: State, id: string): Reservation | undefined =>
  state.reservation?.[id] ? ({ id, ...state.reservation[id] } as Reservation) : undefined;

export const upcoming = (state: State, today: string): Reservation[] =>
  reservations(state).filter((r) => r.ends >= today);

export const past = (state: State, today: string): Reservation[] =>
  reservations(state)
    .filter((r) => r.ends < today)
    .sort((a, b) => byStart(b, a));

/** Inclusive: two camps that share a day share the gear. */
export const overlaps = (a: Pick<Reservation, "starts" | "ends">, b: Pick<Reservation, "starts" | "ends">): boolean =>
  a.starts <= b.ends && b.starts <= a.ends;

export interface Conflict {
  /** The other reservation. */
  id: string;
  event: string;
  detail: string;
}

/**
 * Other reservations this one cannot share the dates with (FR-RES-05). An item
 * named in both is a clash. A generic is a clash when everything reserved of it
 * across the overlapping dates, by count or by name, is more than we have
 * unretired units (FR-RES-15). One entry per other reservation.
 */
export function conflicts(state: State, draft: ReservationInput, excludeId?: string): Conflict[] {
  const others = reservations(state).filter((r) => r.id !== excludeId && overlaps(r, draft));
  const found = new Map<string, string[]>();
  const add = (r: Reservation, detail: string) => found.set(r.id, [...(found.get(r.id) ?? []), detail]);

  for (const other of others) {
    const theirs = namedItems(state, other);
    const shared = namedItems(state, draft).filter((id) => theirs.includes(id));
    for (const id of shared) add(other, nameOf(state, id));
  }

  // Only for generics the draft reserves by count. Named units count once each, however many
  // reservations name them; naming the same tent twice is the item clash above, not a count one.
  const involved = [draft, ...others];
  for (const genericId of new Set(draft.generics.map((g) => g.item_id))) {
    const generic = item(state, genericId);
    // A pool's stock is what it owns (FR-INV-36), not a count of units: it has none (FR-INV-34).
    const owned =
      generic && isPool(generic)
        ? poolCounts(generic).owned
        : unitsOf(state, genericId).filter((u) => !u.retired).length;
    const byCount = (r: ReservationInput) =>
      r.generics.filter((g) => g.item_id === genericId).reduce((n, g) => n + g.quantity, 0);
    const byName = (r: ReservationInput) =>
      namedItems(state, r).filter((id) => state.item?.[id]?.parent_id === genericId);
    const named = new Set(involved.flatMap(byName));
    const total = named.size + involved.reduce((n, r) => n + byCount(r), 0);
    if (total > owned) {
      const name = nameOf(state, genericId);
      for (const other of others) {
        if (byCount(other) > 0 || byName(other).length > 0) add(other, `${total} × ${name}, we have ${owned}`);
      }
    }
  }

  return [...found.entries()].map(([id, details]) => {
    const other = others.find((r) => r.id === id)!;
    return { id, event: other.event, detail: details.join(", ") };
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function shiftIso(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Seven days either side (FR-RES-19). */
function nearWindow(r: Pick<Reservation, "starts" | "ends">): { starts: string; ends: string } {
  return { starts: shiftIso(r.starts, -7), ends: shiftIso(r.ends, 7) };
}

const shortDates = (r: Pick<Reservation, "starts" | "ends">): string =>
  r.starts === r.ends ? r.starts : `${r.starts} – ${r.ends}`;

export interface NearbyNote {
  event: string;
  detail: string;
}

/**
 * A line this draft shares with a camp nearby but not overlapping (FR-RES-19): its dates fall
 * within seven days either side of the draft's. Keyed by item id and by generic id, whichever
 * the other reservation names the same way (by unit or by count). Empty for nothing near; a
 * hint before the block, since an overlap is refused by `conflicts` instead. Twin of `nearby`
 * in views.py's conflicts.py.
 */
export function nearby(state: State, draft: ReservationInput, excludeId?: string): Record<string, NearbyNote[]> {
  if (!draft.starts || !draft.ends) return {};
  const window = nearWindow(draft);
  const others = reservations(state).filter((r) => r.id !== excludeId && !overlaps(r, draft) && overlaps(r, window));
  const found: Record<string, NearbyNote[]> = {};
  const add = (id: string, other: Reservation) => {
    (found[id] ??= []).push({ event: other.event, detail: shortDates(other) });
  };
  for (const other of others) {
    const theirs = new Set(namedItems(state, other));
    for (const id of draft.items) if (theirs.has(id)) add(id, other);
    for (const g of draft.generics) {
      const byCount = other.generics.some((x) => x.item_id === g.item_id);
      const byName = namedItems(state, other).some((id) => state.item?.[id]?.parent_id === g.item_id);
      if (byCount || byName) add(g.item_id, other);
    }
  }
  return found;
}

/** "Also Fall Camp, 2026-10-02 – 2026-10-04". Joins more than one nearby camp with "; ". */
export const nearbyLabel = (notes: NearbyNote[]): string =>
  `Also ${notes.map((n) => `${n.event}, ${n.detail}`).join("; ")}`;

export interface GenericProgress {
  generic: Item;
  quantity: number;
  done: number;
}

export interface Remaining {
  /** Named items not yet out under the event, ordered by home (FR-RES-06). */
  items: Item[];
  /** Named items already out under it: ticked off, and worth seeing (S-RES-04). */
  packed: Item[];
  generics: GenericProgress[];
}

const ticked = (it: Item, event: string): boolean => it.status === "out" && it.movement?.event === event;

/**
 * The items a reservation names, as they stand today: a merged duplicate means
 * its survivor (FR-INV-13), and a deleted record is not there at all
 * (FR-INV-32). Mirrored by named_items in views.py.
 */
const namedItems = (state: State, r: ReservationInput): string[] =>
  [...new Set(r.items.map((id) => resolveItem(state, id)))].filter((id) => !state.item?.[id]?.deleted);

/** What is still to pack. Derived from state alone: a scan anywhere ticks it here after sync. */
export function remaining(state: State, r: Reservation): Remaining {
  const byHome = (a: Item, b: Item) =>
    homeLabel(state, a).localeCompare(homeLabel(state, b)) ||
    displayName(state, a).localeCompare(displayName(state, b));
  const named = namedItems(state, r)
    .map((id) => (state.item?.[id] ? ({ id, ...state.item[id] } as Item) : undefined))
    .filter((it): it is Item => it !== undefined)
    .sort(byHome);
  const left = named.filter((it) => !ticked(it, r.event));
  const packed = named.filter((it) => ticked(it, r.event));

  const chosen = new Set(namedItems(state, r));
  const generics = r.generics.map((g) => {
    const generic = item(state, g.item_id) ?? ({ id: g.item_id, name: "(unknown item)" } as Item);
    if (isPool(generic)) {
      // pool_events accumulates at replay (FR-RES-13): a second visit for the same camp adds to
      // done, it does not replace it. Read off the raw entity: Item does not carry it.
      const poolEvents = (state.item?.[g.item_id]?.pool_events as PoolEvents | undefined) ?? {};
      const done = poolEvents[r.event] ?? 0;
      return { generic, quantity: g.quantity, done: Math.min(done, g.quantity) };
    }
    // Any unit of the generic counts, except one the reservation names: that one is its own line.
    const done = unitsOf(state, g.item_id).filter((u) => !chosen.has(u.id) && ticked(u, r.event)).length;
    return { generic, quantity: g.quantity, done: Math.min(done, g.quantity) };
  });

  return { items: left, packed, generics };
}

export const isPacked = (rem: Remaining): boolean =>
  rem.items.length === 0 && rem.generics.every((g) => g.done >= g.quantity);

// --- actions -------------------------------------------------------------------------------

function actor(store: Store): string {
  const id = store.meta.user?.id;
  if (!id) throw new Error("not signed in");
  return id;
}

function clean(input: ReservationInput): ReservationInput {
  return {
    event: input.event.trim(),
    starts: input.starts,
    ends: input.ends,
    items: [...new Set(input.items)],
    generics: input.generics.filter((g) => g.quantity > 0),
  };
}

export async function createReservation(store: Store, input: ReservationInput): Promise<string> {
  const id = newUlid();
  await store.record({
    entity_type: "reservation",
    entity_id: id,
    type: "created",
    actor_id: actor(store),
    payload: { ...clean(input) },
  });
  return id;
}

/**
 * One field_changed per changed field, old value kept (FR-USR-05). The gear
 * list is the exception: it goes out as one event per line that moved.
 */
export async function updateReservation(store: Store, id: string, patch: Partial<ReservationInput>): Promise<void> {
  const before = reservation(store.state, id);
  if (!before) throw new Error("no such reservation");
  const next = clean({ ...before, ...patch });
  for (const field of ["event", "starts", "ends"] as const) {
    if (!(field in patch)) continue;
    const value = next[field];
    const old = before[field] ?? null;
    if (value === old) continue;
    await store.record({
      entity_type: "reservation",
      entity_id: id,
      type: "field_changed",
      actor_id: actor(store),
      payload: { field, value, old },
    });
  }
  if (patch.items) {
    const was = before.items ?? [];
    for (const gone of was.filter((x) => !next.items.includes(x))) await removeItem(store, id, gone);
    for (const fresh of next.items.filter((x) => !was.includes(x))) await addItem(store, id, fresh);
  }
  if (patch.generics) {
    const was = before.generics ?? [];
    for (const line of was.filter((g) => !next.generics.some((n) => n.item_id === g.item_id))) {
      await setQuantity(store, id, line.item_id, 0);
    }
    for (const line of next.generics) {
      const old = was.find((g) => g.item_id === line.item_id);
      if (old?.quantity !== line.quantity) await setQuantity(store, id, line.item_id, line.quantity);
    }
  }
}

// --- the gear list, one line at a time -------------------------------------------------------

function line(store: Store, id: string, type: string, payload: Record<string, unknown>) {
  if (!reservation(store.state, id)) throw new Error("no such reservation");
  return store.record({ entity_type: "reservation", entity_id: id, type, actor_id: actor(store), payload });
}

/** Name one more item. Already on the list is not an error; replay ignores the repeat. */
export const addItem = (store: Store, id: string, itemId: string) => line(store, id, "item_added", { item_id: itemId });

export const removeItem = (store: Store, id: string, itemId: string) =>
  line(store, id, "item_removed", { item_id: itemId });

/** How many of a generic (FR-RES-13). Zero drops the line. */
export const setQuantity = (store: Store, id: string, itemId: string, quantity: number) =>
  line(store, id, "quantity_changed", { item_id: itemId, quantity });

export type ListChange = { kind: "item"; item_id: string } | { kind: "quantity"; item_id: string; quantity: number };

/**
 * What a check-out under this camp's event has to add to the gear list, once it
 * has happened (FR-RES-07). Nothing, when the item is already named or fills a
 * generic line that had room. A unit whose full line it overflows raises that
 * line by one; anything else joins by name.
 */
export function extraChange(state: State, r: Reservation, itemId: string): ListChange | null {
  const id = resolveItem(state, itemId);
  const named = new Set(namedItems(state, r));
  if (named.has(id)) return null;
  const it = item(state, id);
  if (!it) return null;
  const line = it.parent_id ? r.generics.find((g) => g.item_id === it.parent_id) : undefined;
  if (!line) return { kind: "item", item_id: id };
  const done = unitsOf(state, line.item_id).filter((u) => !named.has(u.id) && ticked(u, r.event)).length;
  return done > line.quantity ? { kind: "quantity", item_id: line.item_id, quantity: line.quantity + 1 } : null;
}

/** Grow the gear list to match what went out. The movement itself is the caller's business. */
export async function addExtra(store: Store, id: string, itemId: string): Promise<void> {
  const r = reservation(store.state, id);
  if (!r) return;
  const change = extraChange(store.state, r, itemId);
  if (!change) return;
  if (change.kind === "item") await addItem(store, id, change.item_id);
  else await setQuantity(store, id, change.item_id, change.quantity);
}

/** Gear that is out under some other event, or none. What this camp can claim (FR-RES-17). */
export function outElsewhere(state: State, r: Reservation): Item[] {
  const named = new Set(namedItems(state, r));
  return movable(state)
    .filter((it) => it.status === "out" && !it.merged_into && !named.has(it.id) && it.movement?.event !== r.event)
    .sort((a, b) => displayName(state, a).localeCompare(displayName(state, b)));
}

/**
 * It went out before the plan did (FR-RES-17, S-RES-07). The movement's event is
 * corrected by an appended record, and the item joins the gear list. Nothing is
 * checked out or in.
 */
export async function linkOut(store: Store, id: string, itemId: string): Promise<void> {
  const r = reservation(store.state, id);
  if (!r) throw new Error("no such reservation");
  const it = item(store.state, resolveItem(store.state, itemId));
  if (!it) throw new Error("no such item");
  const movement = it.movement as Movement | undefined;
  if (it.status !== "out" || !movement) throw new Error("it is not out");
  if (movement.event !== r.event) await correctEvent(store, it.id, movement.id, r.event);
  await addExtra(store, id, it.id);
}

/**
 * Take `count` off a pool's line for this camp (FR-RES-13, FR-OUT-22). A pool moves by count,
 * not by holder, so this does not go through movement.ts's checkOut: that refuses a generic
 * outright (FR-INV-21), and a pool is always one.
 */
export async function checkOutPoolLine(store: Store, r: Reservation, itemId: string, count: number): Promise<void> {
  if (!(count > 0)) return;
  await store.record({
    entity_type: "item",
    entity_id: itemId,
    type: "checked_out",
    actor_id: actor(store),
    payload: { holder_id: actor(store), count, event: r.event },
  });
}

export async function cancelReservation(store: Store, id: string): Promise<void> {
  if (!reservation(store.state, id)) throw new Error("no such reservation");
  await store.record({
    entity_type: "reservation",
    entity_id: id,
    type: "field_changed",
    actor_id: actor(store),
    payload: { field: "cancelled", value: true, old: null },
  });
}
