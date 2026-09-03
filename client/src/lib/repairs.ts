/**
 * Repair tickets (FR-REP-01). A ticket is a `repair` entity that names its
 * item; its state moves by field_changed and its comments are notes. Pure reads
 * over state, and the two writes a person makes.
 */
import { aliases } from "./inventory";
import type { Fields, Note, State } from "./replay";
import type { Store } from "./store";
import { localDate } from "./time";
import { newUlid } from "./ulid";

export type RepairState = "open" | "in_progress" | "resolved" | "wont_fix";

export interface Repair {
  id: string;
  item_id: string;
  description: string;
  state: RepairState;
  notes?: Note[];
  added_at?: number;
  modified_at?: number;
}

/** In the order a ticket moves (FR-REP-03). */
export const REPAIR_STATES: { value: RepairState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
  { value: "wont_fix", label: "Won't fix" },
];

export const stateLabel = (state: RepairState): string => REPAIR_STATES.find((s) => s.value === state)?.label ?? state;

/** Open or in progress: the item is flagged (FR-REP-05). */
export const isOpen = (r: Repair): boolean => r.state === "open" || r.state === "in_progress";

const newest = (a: Repair, b: Repair) => (b.added_at ?? 0) - (a.added_at ?? 0) || (a.id < b.id ? 1 : -1);

export function repairs(state: State): Repair[] {
  return Object.entries(state.repair ?? {}).map(([id, fields]: [string, Fields]) => ({ id, ...fields }) as Repair);
}

export const repair = (state: State, id: string): Repair | undefined =>
  state.repair?.[id] ? ({ id, ...state.repair[id] } as Repair) : undefined;

/** The item's tickets, open first, then newest first. Closed ones stay (FR-REP-04). A merged duplicate's come too. */
export function repairsFor(state: State, itemId: string): Repair[] {
  const own = aliases(state, itemId);
  return repairs(state)
    .filter((r) => own.includes(r.item_id))
    .sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || newest(a, b));
}

export const openRepairs = (state: State, itemId: string): Repair[] => repairsFor(state, itemId).filter(isOpen);

/** Everything still to fix, newest first. */
export const openTickets = (state: State): Repair[] => repairs(state).filter(isOpen).sort(newest);

/**
 * The repair report's history (FR-RPT-02): every ticket raised or changed on a
 * day in [from, to], calendar days where the group is, last change first.
 * Reaches back as far as the state it is given: the server's whole record when
 * there is signal, this device's copy when there is not (FR-INV-31).
 */
export function repairHistory(state: State, fromIso: string, toIso: string): Repair[] {
  const within = (ms: number | undefined) => ms !== undefined && localDate(ms) >= fromIso && localDate(ms) <= toIso;
  return repairs(state)
    .filter((r) => within(r.added_at) || within(r.modified_at))
    .sort((a, b) => (b.modified_at ?? 0) - (a.modified_at ?? 0) || newest(a, b));
}

function actor(store: Store): string {
  const id = store.meta.user?.id;
  if (!id) throw new Error("not signed in");
  return id;
}

/** Any signed-in user (FR-REP-02). Replay opens the ticket open. */
export async function raiseTicket(store: Store, itemId: string, description: string): Promise<string> {
  if (!store.state.item?.[itemId]) throw new Error("no such item");
  const text = description.trim();
  if (!text) throw new Error("say what is wrong");
  const id = newUlid();
  await store.record({
    entity_type: "repair",
    entity_id: id,
    type: "created",
    actor_id: actor(store),
    payload: { item_id: itemId, description: text },
  });
  return id;
}

export async function setRepairState(store: Store, id: string, state: RepairState): Promise<void> {
  const current = repair(store.state, id);
  if (!current) throw new Error("no such ticket");
  if (current.state === state) return;
  await store.record({
    entity_type: "repair",
    entity_id: id,
    type: "field_changed",
    actor_id: actor(store),
    payload: { field: "state", value: state, old: current.state },
  });
}
