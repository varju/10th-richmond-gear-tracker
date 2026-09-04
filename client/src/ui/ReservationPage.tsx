import { Fragment, useState } from "react";
import { displayName, homeLabel, isPool, item, nameOf } from "../lib/inventory";
import {
  cancelReservation,
  checkOutPoolLine,
  conflicts,
  linkOut,
  nearby,
  nearbyLabel,
  outElsewhere,
  remaining,
  reservation,
  type Reservation,
} from "../lib/reservations";
import type { State } from "../lib/replay";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { localMinute } from "../lib/time";
import { useWide } from "../lib/wide";
import { useStore } from "../useStore";
import { statusLabel, userName } from "./labels";
import { Page } from "./Page";
import { datesLabel } from "./Reservations";

/** How many of a pool to check out for this line, taken in one count (FR-RES-13, FR-OUT-22). */
function PoolCheckout({ store, r, itemId, max }: { store: Store; r: Reservation; itemId: string; max: number }) {
  const [count, setCount] = useState(String(max));
  const [busy, setBusy] = useState(false);

  async function go() {
    const n = Number.parseInt(count, 10);
    if (!(n > 0)) return;
    setBusy(true);
    try {
      await checkOutPoolLine(store, r, itemId, n);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input
        type="number"
        min={1}
        max={max}
        inputMode="numeric"
        style={{ width: "4em" }}
        aria-label={`How many ${nameOf(store.state, itemId)} to check out`}
        value={count}
        onChange={(e) => setCount(e.target.value)}
      />
      <button
        className="small"
        type="button"
        disabled={busy}
        onClick={() => void go()}
        aria-label={`Check out ${nameOf(store.state, itemId)}`}
      >
        Check out
      </button>
    </>
  );
}

/** "Added by Alice, 2026-09-01 14:32" (FR-RES-18). Nothing shown for a reservation made before the field existed. */
function addedByLabel(state: State, r: Reservation): string {
  if (!r.created_by) return "";
  const when = r.added_at ? localMinute(r.added_at) : "";
  return [`Added by ${userName(state, r.created_by)}`, when].filter(Boolean).join(", ");
}

/** One camp: what it needs, and the way to start packing it (S-RES-01, S-RES-02). */
export function ReservationPage({ store, id }: { store: Store; id: string }) {
  useStore(store);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const wide = useWide();
  const state = store.state;
  const r = reservation(state, id);

  if (!r) {
    return (
      <Page title="Not found" back="/reservations">
        <p>No reservation with that id. It may not have synced to this device yet.</p>
      </Page>
    );
  }

  const clashes = r.cancelled ? [] : conflicts(state, r, r.id);
  const near = r.cancelled ? {} : nearby(state, r, r.id);
  const others = r.cancelled ? [] : outElsewhere(state, r);
  const rem = remaining(state, r);
  const addedBy = addedByLabel(state, r);
  // One column when the second would be empty.
  const twoCol = wide && others.length > 0;

  /** The session takes the event and the reservation from here; nobody types it again (FR-RES-03). */
  async function checkOut() {
    await store.setMeta({ session_event: r!.event, session_reservation_id: r!.id });
    navigate(`/scan?mode=out&reservation=${id}`);
  }

  /**
   * It went out before the plan did (FR-RES-17, S-RES-07). One tap corrects the
   * movement's event and puts the item on the list. Nothing moves.
   */
  async function link(itemId: string) {
    setError(null);
    try {
      await linkOut(store, id, itemId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not link it");
    }
  }

  async function cancel() {
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    await cancelReservation(store, id);
    setConfirmCancel(false);
  }

  const gear = (
    <>
      <h3 className="section">Items</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {r.items.length === 0 && r.generics.length === 0 && <p className="muted">No gear listed.</p>}
      {r.items.length > 0 && (
        <ul className="items">
          {r.items.map((itemId) => {
            const it = item(state, itemId);
            // Out, but not for this camp: it may have left before the plan did.
            const elsewhere = it?.status === "out" && it.movement?.event !== r.event;
            const note = near[itemId];
            return (
              <Fragment key={itemId}>
                <li>
                  <button className="item" type="button" onClick={() => navigate(`/items/${itemId}`)}>
                    <span className="item-name">{it ? displayName(state, it) : "(unknown item)"}</span>
                    {it && (
                      <span className="muted small">
                        {[homeLabel(state, it), statusLabel(state, it)].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </button>
                  {!r.cancelled && elsewhere && (
                    <button
                      className="small"
                      type="button"
                      onClick={() => void link(itemId)}
                      aria-label={`It's with us: ${displayName(state, it!)}`}
                    >
                      It's with us
                    </button>
                  )}
                </li>
                {note && <li className="near">{nearbyLabel(note)}</li>}
              </Fragment>
            );
          })}
        </ul>
      )}
      {rem.generics.length > 0 && (
        <ul className="names">
          {rem.generics.map((g) => {
            const pool = isPool(g.generic);
            const note = near[g.generic.id];
            return (
              <Fragment key={g.generic.id}>
                <li className="row">
                  <span className="name">
                    {g.quantity} × {nameOf(state, g.generic.id)}
                    {pool && ` — ${g.done} out`}
                  </span>
                  {pool && !r.cancelled && g.done < g.quantity && !g.generic.retired && (
                    <PoolCheckout store={store} r={r} itemId={g.generic.id} max={g.quantity - g.done} />
                  )}
                  {pool && !r.cancelled && g.done < g.quantity && g.generic.retired && (
                    <span className="muted small">Retired</span>
                  )}
                </li>
                {note && <li className="near">{nearbyLabel(note)}</li>}
              </Fragment>
            );
          })}
        </ul>
      )}
    </>
  );

  const linking = (
    <>
      {!r.cancelled && others.length > 0 && (
        <>
          <h3 className="section">Link other gear that is out</h3>
          <div className="row">
            <label className="tight">
              <span>Item</span>
              <select aria-label="Gear that is out" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Choose</option>
                {others.map((it) => (
                  <option key={it.id} value={it.id}>
                    {displayName(state, it)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="small"
              type="button"
              disabled={!pick}
              onClick={() => {
                const chosen = pick;
                setPick("");
                void link(chosen);
              }}
            >
              It's with us
            </button>
          </div>
        </>
      )}
    </>
  );

  return (
    <Page
      title="Reservation"
      back="/reservations"
      actions={
        <>
          {!r.cancelled && (
            <button className="primary" type="button" onClick={checkOut}>
              Check out
            </button>
          )}
          <div className="row">
            <button type="button" onClick={() => navigate(`/reservations/${id}/edit`)}>
              Edit
            </button>
            <button type="button" onClick={() => navigate(`/reservations/new?from=${id}`)}>
              Duplicate
            </button>
          </div>
          {!r.cancelled && (
            <button type="button" className={confirmCancel ? "warn" : ""} onClick={cancel}>
              {confirmCancel ? "Really cancel?" : "Cancel reservation"}
            </button>
          )}
        </>
      }
    >
      <h2 className="item-title">
        {r.event}
        {r.cancelled && <span className="badge">Cancelled</span>}
      </h2>
      <p>{datesLabel(r)}</p>
      {addedBy && <p className="muted small">{addedBy}</p>}
      {clashes.length > 0 && (
        <p className="notice" role="note">
          Needed for {clashes.map((c) => `${c.event} (${c.detail})`).join("; ")}.
        </p>
      )}

      {/* At a desk the list stands beside the gear that might join it (NFR-USE-10). */}
      {twoCol ? (
        <div className="two-col">
          <div>{gear}</div>
          <div>{linking}</div>
        </div>
      ) : (
        <>
          {gear}
          {linking}
        </>
      )}
    </Page>
  );
}
