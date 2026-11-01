import { useState } from "react";
import {
  past,
  type Reservation,
  reserveFromEvent,
  todayIso,
  type Unplanned,
  unplanned,
  upcoming,
} from "../lib/reservations";
import { navigate } from "../lib/router";
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

/** The event this device's check-outs record, with a way to change it (FR-OUT-05). */
function CurrentEvent({ store }: { store: Store }) {
  const { now } = useShell();
  const { event } = sessionEvent(store.meta, now());
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(name: string | undefined) {
    if (busy) return;
    setBusy(true);
    try {
      await setSessionEvent(store, name);
      setEditing(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the event");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <EventPicker
        store={store}
        label="Check-out event"
        busy={busy}
        error={error}
        lastUsed={store.meta.session_event}
        hide={event}
        onPick={(name) => void pick(name)}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="session">
      <span>{event ? `Check-outs go to: ${event}` : "Check-outs have no event"}</span>
      <button type="button" className="minor" onClick={() => setEditing(true)}>
        Change
      </button>
    </div>
  );
}

/** The camps ahead, and the way to plan a new one (S-RES-01). */
export function Reservations({ store }: { store: Store }) {
  useStore(store);
  const { now } = useShell();
  const today = todayIso(now());
  const ahead = upcoming(store.state, today);
  const gone = past(store.state, today);
  const loose = unplanned(store, now());

  return (
    <Page
      title="Events"
      back="/"
      actions={
        <button className="primary" type="button" onClick={() => navigate("/events/new")}>
          New event
        </button>
      }
    >
      <CurrentEvent store={store} />
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
