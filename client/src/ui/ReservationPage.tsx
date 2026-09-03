import { useState } from "react";
import { displayName, homeLabel, item, nameOf } from "../lib/inventory";
import { cancelReservation, conflicts, linkOut, outElsewhere, reservation } from "../lib/reservations";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useWide } from "../lib/wide";
import { useStore } from "../useStore";
import { statusLabel } from "./labels";
import { Page } from "./Page";
import { datesLabel } from "./Reservations";

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
        <p>No reservation with that id. It may not have synced to this phone yet.</p>
      </Page>
    );
  }

  const clashes = r.cancelled ? [] : conflicts(state, r, r.id);
  const others = r.cancelled ? [] : outElsewhere(state, r);
  // One column when the second would be empty.
  const twoCol = wide && others.length > 0;

  /** The session takes the event from here; nobody types it again (FR-RES-03). */
  async function checkOut() {
    await store.setMeta({ session_event: r!.event });
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
            return (
              <li key={itemId}>
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
            );
          })}
        </ul>
      )}
      {r.generics.length > 0 && (
        <ul className="names">
          {r.generics.map((g) => (
            <li key={g.item_id} className="row">
              <span className="name">
                {g.quantity} × {nameOf(state, g.item_id)}
              </span>
            </li>
          ))}
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
      {clashes.length > 0 && (
        <p className="notice" role="note">
          Also reserved for {clashes.map((c) => `${c.event} (${c.detail})`).join("; ")}.
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
