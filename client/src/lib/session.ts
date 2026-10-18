/**
 * The plain scanning session's event (FR-OUT-05): a device setting, asked once a session. A session
 * ends SESSION_MS after its event was last set, answered, or moved under (FR-OUT-38), so a phone
 * picked up the next evening asks again, and an ended session stamps nothing. Packing a reservation
 * takes its event from the reservation instead, and never ends or extends this way (FR-RES-24, FR-RES-25). Times are the
 * store's clock, the one every move is stamped with.
 */
import { eventNameKey } from "./calendar";
import type { Meta, Store } from "./store";

export const SESSION_MS = 4 * 3_600_000;

/** What a move records from its session: the event, and the reservation it packs. */
export interface Session {
  event?: string;
  reservation_id?: string;
}

/**
 * Whether a plain session is running: its event has been set or answered, and it has not gone
 * idle. A reservation link left by an older build's packing means it is not a plain session, so
 * it counts as ended until the event is next set, which clears the link.
 */
export function eventAsked(meta: Pick<Meta, "session_event_at" | "session_reservation_id">, now: number): boolean {
  if (meta.session_reservation_id !== undefined) return false;
  return meta.session_event_at !== undefined && now - meta.session_event_at < SESSION_MS;
}

/** What a move records from the running session: its event, never a reservation. Nothing once it has ended. */
export function sessionEvent(meta: Meta, now: number): Session {
  return eventAsked(meta, now) ? { event: meta.session_event } : {};
}

/**
 * Set or clear (undefined) the session event, as answered now. Drops any reservation link an older
 * build left. A new answer starts the session afresh. The same answer keeps its start. A `change`
 * to a running session keeps its start too, and remembers the event it replaces, so the moves made
 * under that one can be offered for correcting until the question is answered (FR-OUT-40).
 */
export async function setSessionEvent(store: Store, name: string | undefined, change = false): Promise<void> {
  const now = store.now();
  const event = name?.trim() || undefined;
  const { meta } = store;
  const running = eventAsked(meta, now);
  const same = running && eventNameKey(meta.session_event ?? "") === eventNameKey(event ?? "");
  const keep = same || (running && change);
  // What a change replaces, kept until its question is answered. A fresh start has none.
  let prior = keep ? meta.session_prior_events : undefined;
  const old = meta.session_event ?? null;
  if (keep && !same && !prior?.includes(old)) prior = [...(prior ?? []), old];
  await store.setMeta({
    session_event: event,
    session_reservation_id: undefined,
    session_event_at: now,
    session_started_at: keep ? meta.session_started_at : now,
    session_prior_events: prior,
  });
}

/** Only new moves count from here: the earlier ones keep the event they were made under (FR-OUT-40). */
export async function restartSession(store: Store): Promise<void> {
  await store.setMeta({ session_started_at: store.now(), session_prior_events: undefined });
}
