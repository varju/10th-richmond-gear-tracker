import { useState } from "react";
import { homeLabel, item, typeName } from "../lib/inventory";
import { cancelReservation, conflicts, reservation } from "../lib/reservations";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { statusLabel } from "./labels";
import { Page } from "./Page";
import { datesLabel } from "./Reservations";

/** One camp: what it needs, and the way to start packing it (S-RES-01, S-RES-02). */
export function ReservationPage({ store, id }: { store: Store; id: string }) {
  useStore(store);
  const [confirmCancel, setConfirmCancel] = useState(false);
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

  /** The session takes the event from here; nobody types it again (FR-RES-03). */
  async function checkOut() {
    await store.setMeta({ session_event: r!.event });
    navigate(`/scan?reservation=${id}`);
  }

  async function cancel() {
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    await cancelReservation(store, id);
    setConfirmCancel(false);
  }

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

      <h3 className="section">Items</h3>
      {r.items.length === 0 && r.types.length === 0 && <p className="muted">No gear listed.</p>}
      {r.items.length > 0 && (
        <ul className="items">
          {r.items.map((itemId) => {
            const it = item(state, itemId);
            return (
              <li key={itemId}>
                <button className="item" type="button" onClick={() => navigate(`/items/${itemId}`)}>
                  <span className="item-name">{it?.name ?? "(unknown item)"}</span>
                  {it && (
                    <span className="muted small">
                      {[homeLabel(state, it), statusLabel(state, it)].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {r.types.length > 0 && (
        <ul className="names">
          {r.types.map((t) => (
            <li key={t.type_id} className="row">
              <span className="name">
                {t.quantity} × {typeName(state, t.type_id)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
