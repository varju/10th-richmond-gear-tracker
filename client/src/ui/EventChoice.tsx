import { type FormEvent, useEffect, useRef, useState } from "react";
import { eventDates, eventNameKey, type EventSuggestion, eventsOn, matchingEvents } from "../lib/calendar";
import { answerEvent, knownEventNames } from "../lib/movement";
import { awaitingAnswer } from "../lib/session";
import { todayIso } from "../lib/reservations";
import type { Store } from "../lib/store";
import { useShell } from "../shell";
import { useStore } from "../useStore";

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
 * is No event; `onCancel` picks nothing. Without it, Create and No event are equal answers. `error`
 * shows above the choices. `lastUsed` is the row offered first; `hide` is a name not to offer, such
 * as the one already recorded.
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
  onCancel?: () => void;
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
        <button type="submit" className={onCancel ? undefined : "primary"} disabled={busy || !typed}>
          Create
        </button>
      </form>
      <div className="row">
        <button
          type="button"
          className={onCancel ? undefined : "primary"}
          disabled={busy}
          onClick={() => onPick(undefined)}
        >
          No event
        </button>
        {onCancel && (
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}

/** How long the event question ignores taps after it appears: the tap after a check-out is not an answer. */
export const STRIP_SETTLE_MS = 500;

/**
 * The event question, asked once check-outs wait for it (FR-OUT-05). No Cancel: the moves are done,
 * and Return undoes a check-out. The first tap wins; a second, before the screen catches up, is
 * ignored. The "Last used" event is offered even after its session has ended.
 */
export function EventStrip({ store }: { store: Store }) {
  useStore(store);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const shown = awaitingAnswer(store.meta, store.now());
  useEffect(() => {
    setSettled(false);
    if (!shown) return;
    const timer = setTimeout(() => setSettled(true), STRIP_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  async function answer(name: string | undefined) {
    if (done.current) return;
    done.current = true;
    setBusy(true);
    setError(null);
    try {
      await answerEvent(store, name);
    } catch (e) {
      // The moves stand: say so plainly, and let the person try again.
      console.error("could not save the session event", e);
      setError("Could not save the event. Try again.");
    }
    done.current = false;
    setBusy(false);
  }

  if (!shown) return null;
  return (
    <EventPicker
      store={store}
      label="Which event"
      busy={busy || !settled}
      lastUsed={store.meta.session_event}
      error={error}
      onPick={(name) => void answer(name)}
    />
  );
}
