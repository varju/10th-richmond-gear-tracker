import { useState } from "react";
import { flushSync } from "react-dom";
import {
  past,
  type Reservation,
  reserveFromEvent,
  todayIso,
  type Unplanned,
  unplanned,
  upcoming,
} from "../lib/reservations";
import { back, navigate, useRoute } from "../lib/router";
import { sessionEvent, setSessionEvent } from "../lib/session";
import type { Store } from "../lib/store";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { EventPicker } from "./EventChoice";
import { plural } from "./labels";
import { Page } from "./Page";

/** "2026-10-02 – 2026-10-04", or one day. */
export function datesLabel(r: Pick<Reservation, "starts" | "ends">): string {
  return r.starts === r.ends ? r.starts : `${r.starts} – ${r.ends}`;
}

/** How much gear a reservation asks for: named items plus type quantities. */
export function countLabel(r: Reservation): string {
  const n = r.items.length + r.generics.reduce((sum, g) => sum + g.quantity, 0);
  return plural(n, "item");
}

function Rows({ list }: { list: Reservation[] }) {
  return (
    <ul className="items">
      {list.map((r) => (
        <li key={r.id}>
          <button className="item" type="button" onClick={() => navigate(`/events/${r.id}`)}>
            <span className="item-name">{r.event}</span>
            <span className="muted small">
              {datesLabel(r)} · {countLabel(r)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Events with gear out and no reservation; one tap makes one from the gear (FR-RES-28, FR-RES-31). */
function UnplannedRows({ store, list, now }: { store: Store; list: Unplanned[]; now: () => number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reserve(key: string) {
    setBusy(true);
    setError(null);
    try {
      const made = await reserveFromEvent(store, key, now());
      if (made.kind === "gone") {
        setError("That gear is no longer out.");
        return;
      }
      // Whatever did not link is still on the list, with It's with us to try again.
      const query = new URLSearchParams();
      if (made.unlinked.length) query.set("unlinked", made.unlinked.join(","));
      if (made.error) query.set("why", made.error);
      const search = query.toString() ? `?${query}` : "";
      navigate(`/events/${made.id}${search}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not make the event");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="names">
        {list.map((u) => (
          <li key={u.key} className="row">
            <span className="name">
              {u.event}
              <br />
              <span className="muted small">
                {datesLabel(u)} · {plural(u.items.length + u.pools.reduce((n, p) => n + p.count, 0), "item")} out
              </span>
            </span>
            <button
              className="small"
              type="button"
              disabled={busy}
              onClick={() => void reserve(u.key)}
              aria-label={`Add ${u.event}`}
            >
              Add
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The picker for the event this device's check-outs record; it is open while the address has `change`. */
function ChangeEvent({ store, event }: { store: Store; event: string | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(name: string | undefined) {
    if (busy) return;
    setBusy(true);
    try {
      await setSessionEvent(store, name);
      if (new URLSearchParams(location.search).has("change")) back("/events");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the event");
      setBusy(false);
    }
  }

  return (
    <EventPicker
      store={store}
      label="Check-out event"
      busy={busy}
      error={error}
      lastUsed={store.meta.session_event}
      hide={event}
      onPick={(name) => void pick(name)}
      onCancel={() => back("/events")}
    />
  );
}

/** The event this device's check-outs record, with a way to change it (FR-OUT-05). */
function CurrentEvent({ event }: { event: string | undefined }) {
  return (
    <div className="session">
      <span>{event ? `Check-outs go to: ${event}` : "Check-outs have no event"}</span>
      <button type="button" className="minor" onClick={() => navigate("/events?change=1")}>
        Change
      </button>
    </div>
  );
}

/** The camps ahead, and the way to plan a new one (S-RES-01). */
export function Reservations({ store }: { store: Store }) {
  /** iOS raises the keyboard only for a focus inside the tap, so the form is rendered before the tap ends. */
  const newEvent = () => {
    flushSync(() => navigate("/events/new"));
    document.querySelector<HTMLInputElement>("main input[name=event]")?.focus();
  };
  useStore(store);
  const { now } = useShell();
  const today = todayIso(now());
  const ahead = upcoming(store.state, today);
  const gone = past(store.state, today);
  const loose = unplanned(store, now());
  const changing = useRoute().query.has("change");
  const { event } = sessionEvent(store.meta, now());

  if (changing) {
    return (
      <Page title="Events" back="/events">
        <ChangeEvent store={store} event={event} />
      </Page>
    );
  }
  return (
    <Page
      title="Events"
      back="/"
      actions={
        <button className="primary" type="button" onClick={newEvent}>
          New event
        </button>
      }
    >
      <CurrentEvent event={event} />
      {ahead.length === 0 && gone.length === 0 && loose.length === 0 && <p>No events.</p>}
      {ahead.length > 0 && <Rows list={ahead} />}
      {loose.length > 0 && <UnplannedRows store={store} list={loose} now={now} />}
      {gone.length > 0 && (
        <details className="filters">
          <summary>Past ({gone.length})</summary>
          <Rows list={gone} />
        </details>
      )}
    </Page>
  );
}
