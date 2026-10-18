import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { eventDates, eventNameKey, type EventSuggestion, eventsOn, matchingEvents } from "../lib/calendar";
import { knownEventNames } from "../lib/movement";
import { todayIso } from "../lib/reservations";
import { eventAsked, type Session, sessionEvent, setSessionEvent } from "../lib/session";
import type { Store } from "../lib/store";
import { useShell } from "../shell";

/** Calendar events and names used before that match `typed` (FR-RES-20, FR-RES-27). Empty for a blank one. */
export function typedEvents(store: Store, typed: string): EventSuggestion[] {
  if (!typed.trim()) return [];
  return matchingEvents(store.meta.calendar_events, typed, knownEventNames(store));
}

/** Events to pick from, one tap each (FR-RES-20). A name used before has no dates (FR-RES-27). */
export function EventSuggestions({
  events,
  disabled = false,
  onPick,
}: {
  events: EventSuggestion[];
  disabled?: boolean;
  onPick: (picked: EventSuggestion) => void;
}) {
  return (
    <ul className="rows">
      {events.map((ev) => (
        <li key={`${ev.summary}-${ev.starts}-${ev.ends}`}>
          <button
            type="button"
            className="row"
            disabled={disabled}
            // Keep the focus in a text field beside the list, so the tap lands before it blurs.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(ev)}
          >
            <span>{ev.summary}</span>
            <span className="muted">{eventDates(ev)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Pick an event: the last one used and today's calendar events, each one tap (FR-OUT-29), what
 * matches as the person types (FR-RES-27), or No event in one tap (FR-OUT-30). `onPick(undefined)`
 * is No event; `onCancel` picks nothing. `error` shows above the choices. `lastUsed` is the row
 * offered first; `hide` is a name not to offer, such as the one already recorded.
 */
export function EventPicker({
  store,
  label,
  busy,
  error,
  lastUsed,
  hide,
  onPick,
  onCancel,
}: {
  store: Store;
  label: string;
  busy: boolean;
  error?: string | null;
  lastUsed?: string;
  hide?: string | null;
  onPick: (name: string | undefined) => void;
  onCancel: () => void;
}) {
  const { now } = useShell();
  const [draft, setDraft] = useState("");
  const typed = draft.trim();
  const hidden = hide ? eventNameKey(hide) : null;
  const current = lastUsed && eventNameKey(lastUsed) !== hidden ? lastUsed : undefined;
  const offered = (
    typed
      ? typedEvents(store, typed)
      : eventsOn(store.meta.calendar_events, todayIso(now())).filter(
          (e) => !current || eventNameKey(e.summary) !== eventNameKey(current),
        )
  ).filter((e) => eventNameKey(e.summary) !== hidden);

  function create(e: FormEvent) {
    e.preventDefault();
    if (typed) onPick(typed);
  }

  return (
    <section className="event-choice" aria-label={label}>
      <p>Which event?</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!typed && current && (
        <ul className="rows">
          <li>
            <button type="button" className="row" disabled={busy} onClick={() => onPick(current)}>
              <span>{current}</span>
              <span className="muted">Last used</span>
            </button>
          </li>
        </ul>
      )}
      {offered.length > 0 && <EventSuggestions events={offered} disabled={busy} onPick={(ev) => onPick(ev.summary)} />}
      <form className="event-typed" onSubmit={create}>
        <input
          aria-label="Event"
          placeholder="Event, e.g. Spring camp"
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={busy || !typed}>
          Create
        </button>
      </form>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => onPick(undefined)}>
          No event
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/**
 * Which event this scanning session's moves record under, asked at its first check-out or
 * transfer (FR-OUT-05). `onDone(false)` is Cancel: no move. The first tap wins; a second, before
 * the screen catches up, is ignored, so a move never runs twice. The "Last used" event is offered
 * even after its session has ended; picking it starts a new one.
 */
function EventChoice({ store, onDone }: { store: Store; onDone: (chosen: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  async function finish(chosen: boolean, name?: string) {
    if (done.current) return;
    done.current = true;
    setBusy(true);
    setError(null);
    if (chosen) {
      try {
        await setSessionEvent(store, name);
      } catch (e) {
        // Nothing moved: say so plainly, and let the person try again or cancel.
        console.error("could not save the session event", e);
        done.current = false;
        setBusy(false);
        setError("Could not save the event. Try again.");
        return;
      }
    }
    onDone(chosen);
  }

  return (
    <EventPicker
      store={store}
      label="Which event"
      busy={busy}
      lastUsed={store.meta.session_event}
      error={error}
      onPick={(name) => void finish(true, name)}
      onCancel={() => void finish(false)}
    />
  );
}

/**
 * The event question in front of a move that records one (FR-OUT-05). `fixed` is a reservation's
 * packing session, which takes its event and link from the reservation and never asks (FR-RES-03).
 * Otherwise the device's running session answers, and once it has ended the question is asked
 * again (FR-OUT-38). Checked when the move is made, not when the screen drew, so a shown event that
 * has since ended asks rather than recording nothing. `askThen(go)` calls `go` with what the move
 * records, now or once answered; `question(children)` is the card while it waits, or null.
 */
export function useEventQuestion(store: Store, fixed?: Session) {
  const [pending, setPending] = useState<((session: Session) => void) | null>(null);

  function askThen(go: (session: Session) => void) {
    if (fixed) return go(fixed);
    const now = store.now();
    if (eventAsked(store.meta, now)) go(sessionEvent(store.meta, now));
    else setPending(() => go);
  }

  function question(children: ReactNode): ReactNode {
    if (!pending) return null;
    return (
      <div className="move-actions">
        <EventChoice
          store={store}
          onDone={(chosen) => {
            setPending(null);
            if (chosen) pending(sessionEvent(store.meta, store.now()));
          }}
        />
        {children}
      </div>
    );
  }

  return { askThen, question };
}
