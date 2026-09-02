import { past, type Reservation, todayIso, upcoming } from "../lib/reservations";
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

/** The camps ahead, and the way to plan a new one (S-RES-01). */
export function Reservations({ store }: { store: Store }) {
  useStore(store);
  const { now } = useShell();
  const today = todayIso(now());
  const ahead = upcoming(store.state, today);
  const gone = past(store.state, today);

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
      {gone.length > 0 && (
        <details className="filters">
          <summary>Past ({gone.length})</summary>
          <Rows list={gone} />
        </details>
      )}
    </Page>
  );
}
