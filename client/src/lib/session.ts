/**
 * The plain scanning session's event (FR-OUT-05): a device setting. A session starts at its first
 * check-out, which moves at once with no event and waits for the answer, or when the event is set.
 * It ends SESSION_MS after its event was last set, answered, or moved under (FR-OUT-38), so a phone
 * picked up the next evening asks again, and an ended session stamps nothing. Packing a reservation
 * takes its event from the reservation instead, and never ends or extends this way (FR-RES-24, FR-RES-25). Times are the
 * store's clock, the one every move is stamped with.
 */
import { type Meta, type MoveSession, SESSION_KEYS, type Store } from "./store";

export const SESSION_MS = 4 * 3_600_000;

/**
 * What a move records from its session: the event, and the reservation it packs. `waits` is a plain
 * session whose event is not answered: a check-out records no event and waits for the answer, and a
 * transfer keeps the event and reservation the gear is out under.
 */
export interface Session {
  event?: string;
  reservation_id?: string;
  waits?: boolean;
}

export type SessionMeta = Pick<
  Meta,
  "session_event" | "session_event_at" | "session_reservation_id" | "session_waiting" | "session_waiting_user"
>;

/** The session's settings and who is signed in. */
type Seen = Partial<SessionMeta> & Pick<Meta, "user">;

/**
 * Whether a plain session is running: it has started, and it has not gone idle. A reservation link
 * left by an older build's packing means it is not a plain session, so it counts as ended until the
 * event is next set, which clears the link. A session waiting for someone else's answer has ended for
 * whoever else is signed in, so no one answers for, or records under, another person's session.
 */
export function eventAsked(meta: Seen, now: number): boolean {
  if (meta.session_reservation_id !== undefined) return false;
  if (meta.session_waiting !== undefined && meta.session_waiting_user !== meta.user?.id) return false;
  return meta.session_event_at !== undefined && now - meta.session_event_at < SESSION_MS;
}

/** Whether a running session waits for its event: the question shows until the answer is saved. */
export function awaitingAnswer(meta: Seen, now: number): boolean {
  return eventAsked(meta, now) && meta.session_waiting !== undefined;
}

/** What a plain move records from the session: its answered event, never a reservation. */
export function sessionEvent(meta: Meta, now: number): Session {
  if (!eventAsked(meta, now) || awaitingAnswer(meta, now)) return { waits: true };
  return { event: meta.session_event };
}

/** The check-outs waiting for the running session's event, by movement id. */
export function waitingIds(meta: Seen, now: number): string[] {
  return eventAsked(meta, now) ? meta.session_waiting ?? [] : [];
}

/**
 * The session after a move made in it by `user`, or undefined when the move leaves it alone. A
 * waiting check-out starts a session, or joins a running one still waiting for its answer; an
 * answered one stays answered. A transfer of a waiting check-out waits in its place, and a pool's
 * send-home or return from home that splits a waiting lot adds the split part. A return or a
 * correction by hand takes its check-outs off the list (`ends`); the last one off ends the session,
 * keeping its event as Last used. Any other move keeps a running session going; one that stamped an
 * event only if that is still the session's, so a stale tab does not keep another tab's different
 * event going.
 */
export function afterMove(
  read: SessionMeta,
  session: MoveSession,
  id: string,
  at: number,
  user: Meta["user"],
): SessionMeta | undefined {
  const running = eventAsked({ ...read, user }, at);
  const list = running ? read.session_waiting : undefined;
  if (session.splits !== undefined) {
    if (!list?.includes(session.splits)) return undefined;
    return { ...read, session_waiting: [...list, id] };
  }
  if (!running) {
    if (!session.waits) return undefined;
    return {
      session_event: read.session_event,
      session_event_at: at,
      session_waiting: [id],
      session_waiting_user: user?.id,
    };
  }
  let waiting = session.waits && list ? [...list, id] : list?.map((w) => (w === session.supersedes ? id : w));
  if (session.ends && waiting) {
    waiting = waiting.filter((w) => !session.ends!.includes(w));
    if (waiting.length === 0) return { session_event: read.session_event };
  }
  if (!session.waits && "event" in session && (session.event || undefined) !== read.session_event) {
    return waiting?.join() !== list?.join() ? { ...read, session_waiting: waiting } : undefined;
  }
  return { ...read, session_event_at: at, session_waiting: waiting };
}

/** Take an answered check-out off the waiting list, once it has its event and list. The session waits on until saved. */
export async function settleWaiting(store: Store, id: string): Promise<void> {
  const at = store.now();
  await store.updateMeta(SESSION_KEYS, (read) => {
    const list = waitingIds({ ...read, user: store.meta.user }, at);
    return list.includes(id) ? { session_waiting: list.filter((w) => w !== id) } : {};
  });
}

/**
 * Set or clear (undefined) the session event, as answered now, and return the check-outs still
 * waiting. Drops any reservation link an older build left. `answered` are the waiting check-outs this
 * answer settles; one that joined the list since stays on it, and the session waits on. A new answer starts the session afresh; the same answer keeps it running.
 * Moves already made keep the event they were made under; `answerEvent` relinks the waiting ones.
 */
export async function setSessionEvent(store: Store, name: string | undefined, answered: string[]): Promise<string[]> {
  const event = name?.trim() || undefined;
  const at = store.now();
  const next = await store.updateMeta(SESSION_KEYS, (read) => {
    const left = waitingIds({ ...read, user: store.meta.user }, at).filter((id) => !answered.includes(id));
    return {
      session_event: event,
      session_reservation_id: undefined,
      session_waiting: left.length > 0 ? left : undefined,
      session_waiting_user: left.length > 0 ? read.session_waiting_user : undefined,
      session_event_at: at,
    };
  });
  return next.session_waiting ?? [];
}
