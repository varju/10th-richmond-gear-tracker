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
import type { Store } from "../lib/store";
import { useShell } from "../shell";
import { useStore } from "../useStore";
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
          <button className="item" type="button" onClick={() => navigate(`/reservations/${r.id}`)}>
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
      navigate(`/reservations/${made.id}${search}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not make the reservation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="section">Out with no reservation</h2>
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
                {datesLabel(u)} · {plural(u.items.length, "item")} out
              </span>
            </span>
            <button
              className="small"
              type="button"
              disabled={busy}
              onClick={() => void reserve(u.key)}
              aria-label={`Reserve ${u.event}`}
            >
              Reserve
            </button>
          </li>
        ))}
      </ul>
    </>
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
      title="Reservations"
      back="/"
      actions={
        <button className="primary" type="button" onClick={() => navigate("/reservations/new")}>
          New reservation
        </button>
      }
    >
      {ahead.length === 0 ? <p>Nothing planned.</p> : <Rows list={ahead} />}
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
