/**
 * Reservations: planning a camp, then packing for it (FR-RES-01, FR-RES-02).
 *
 * A reservation is an entity on the log: created whole, edited by
 * field_changed, cancelled by a field. Packing progress is not recorded
 * anywhere. An item is ticked off when it is out under the reservation's
 * event, which replay already knows, so two phones packing one camp agree
 * after a sync and a reload loses nothing.
 */
import { displayName, homeLabel, type Item, item, nameOf, resolveItem, unitsOf } from "./inventory";
import type { Fields, State } from "./replay";
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
    const owned = unitsOf(state, genericId).filter((u) => !u.retired).length;
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

export interface GenericProgress {
  generic: Item;
  quantity: number;
  done: number;
}

export interface Remaining {
  /** Named items not yet out under the event, ordered by home (FR-RES-06). */
  items: Item[];
  generics: GenericProgress[];
}

const ticked = (it: Item, event: string): boolean => it.status === "out" && it.movement?.event === event;

/** The items a reservation names, as they stand today: a merged duplicate means its survivor (FR-INV-13). */
const namedItems = (state: State, r: ReservationInput): string[] => [
  ...new Set(r.items.map((id) => resolveItem(state, id))),
];

/** What is still to pack. Derived from state alone: a scan anywhere ticks it here after sync. */
export function remaining(state: State, r: Reservation): Remaining {
  const left = namedItems(state, r)
    .map((id) => (state.item?.[id] ? ({ id, ...state.item[id] } as Item) : undefined))
    .filter((it): it is Item => it !== undefined && !ticked(it, r.event))
    .sort(
      (a, b) =>
        homeLabel(state, a).localeCompare(homeLabel(state, b)) ||
        displayName(state, a).localeCompare(displayName(state, b)),
    );

  const chosen = new Set(namedItems(state, r));
  const generics = r.generics.map((g) => {
    const generic = item(state, g.item_id) ?? ({ id: g.item_id, name: "(unknown item)" } as Item);
    // Any unit of the generic counts, except one the reservation names: that one is its own line.
    const done = unitsOf(state, g.item_id).filter((u) => !chosen.has(u.id) && ticked(u, r.event)).length;
    return { generic, quantity: g.quantity, done: Math.min(done, g.quantity) };
  });

  return { items: left, generics };
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

/** One field_changed per field that differs, old value kept (FR-USR-05). Lists are compared whole. */
export async function updateReservation(store: Store, id: string, patch: Partial<ReservationInput>): Promise<void> {
  const before = reservation(store.state, id);
  if (!before) throw new Error("no such reservation");
  const next = clean({ ...before, ...patch });
  for (const field of Object.keys(patch) as (keyof ReservationInput)[]) {
    const value = next[field];
    const old = before[field] ?? null;
    if (JSON.stringify(value) === JSON.stringify(old)) continue;
    await store.record({
      entity_type: "reservation",
      entity_id: id,
      type: "field_changed",
      actor_id: actor(store),
      payload: { field, value, old },
    });
  }
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
