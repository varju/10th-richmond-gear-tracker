import { useState } from "react";
import { displayName, generics, homeLabel, nameOf, search } from "../lib/inventory";
import {
  conflicts,
  createReservation,
  reservation,
  type ReservationInput,
  updateReservation,
} from "../lib/reservations";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { guard, useUnsaved } from "../lib/unsaved";
import { useWide } from "../lib/wide";
import { useStore } from "../useStore";
import { Page } from "./Page";

interface Props {
  store: Store;
  /** Editing this reservation. Absent means a new one. */
  id?: string;
  /** A reservation to copy the event and gear from (FR-RES-10). */
  from?: string | null;
}

const EMPTY: ReservationInput = { event: "", starts: "", ends: "", items: [], generics: [] };

function initial(store: Store, id?: string, from?: string | null): ReservationInput {
  const source = reservation(store.state, id ?? from ?? "");
  if (!source) return EMPTY;
  const { event, items } = source;
  const lines = source.generics;
  // A copy keeps the gear and the name; the dates are the one thing that is always new.
  return id
    ? { event, starts: source.starts, ends: source.ends, items, generics: lines }
    : { ...EMPTY, event, items, generics: lines };
}

/** Event, dates, and gear by name or so many of a generic (FR-RES-01, FR-RES-13). New, edit and duplicate. */
export function ReservationForm({ store, id, from }: Props) {
  useStore(store);
  const [values, setValues] = useState<ReservationInput>(() => initial(store, id, from));
  const [start] = useState(values);
  const [query, setQuery] = useState("");
  const [genericId, setGenericId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const wide = useWide();
  const state = store.state;
  const set = (patch: Partial<ReservationInput>) => setValues((v) => ({ ...v, ...patch }));

  const complete = values.event.trim() !== "" && values.starts !== "" && values.ends !== "";
  const dirty = JSON.stringify(values) !== JSON.stringify(start);
  useUnsaved(dirty, { save, canSave: complete });

  const back = id ? `/reservations/${id}` : "/reservations";

  async function save(): Promise<boolean> {
    if (!complete) return false;
    if (values.ends < values.starts) {
      setError("It ends before it starts.");
      return false;
    }
    // Blocked here, on this phone's state (FR-RES-05). Two phones offline can both save; the page names the clash.
    const clashes = conflicts(state, values, id);
    if (clashes.length > 0) {
      setError(`Already reserved for ${clashes.map((c) => `${c.event} (${c.detail})`).join("; ")}.`);
      return false;
    }
    setSaving(true);
    try {
      const target = id ?? (await createReservation(store, values));
      if (id) await updateReservation(store, id, values);
      navigate(`/reservations/${target}`, true);
      return true;
    } finally {
      setSaving(false);
    }
  }

  const results = query.trim() ? search(state, { query }).filter((it) => !values.items.includes(it.id)) : [];

  function addGeneric() {
    const n = Number.parseInt(quantity, 10);
    if (!genericId || !(n > 0)) return;
    const rest = values.generics.filter((g) => g.item_id !== genericId);
    set({ generics: [...rest, { item_id: genericId, quantity: n }] });
    setGenericId("");
    setQuantity("1");
  }

  const gearList = (
    <>
      <h3 className="section">Items</h3>
      <ul className="names">
        {values.items.map((itemId) => {
          return (
            <li key={itemId} className="row">
              <span className="name">{nameOf(state, itemId)}</span>
              <button
                className="small"
                type="button"
                onClick={() => set({ items: values.items.filter((x) => x !== itemId) })}
                aria-label={`Remove ${nameOf(state, itemId)}`}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );

  const addItem = (
    <>
      <input
        aria-label="Add an item"
        placeholder="Search items to add"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
      />
      {results.length > 0 && (
        <ul className="rows">
          {results.slice(0, 8).map((it) => (
            <li key={it.id}>
              <button
                type="button"
                className="row"
                onClick={() => {
                  set({ items: [...values.items, it.id] });
                  setQuery("");
                }}
              >
                <span>{displayName(state, it)}</span>
                <span className="muted">{homeLabel(state, it)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const quantities = (
    <>
      <h3 className="section">So many of one thing</h3>
      <ul className="names">
        {values.generics.map((g) => (
          <li key={g.item_id} className="row">
            <span className="name">
              {g.quantity} × {nameOf(state, g.item_id)}
            </span>
            <button
              className="small"
              type="button"
              onClick={() => set({ generics: values.generics.filter((x) => x.item_id !== g.item_id) })}
              aria-label={`Remove ${nameOf(state, g.item_id)}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </>
  );

  const addQuantity = (
    <>
      <div className="row">
        <label className="tight">
          <span>Item</span>
          <select aria-label="Item" value={genericId} onChange={(e) => setGenericId(e.target.value)}>
            <option value="">Choose</option>
            {generics(state)
              .filter((g) => !g.retired)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
        </label>
        <label className="tight">
          <span>How many</span>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            aria-label="How many"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <button className="small" type="button" onClick={addGeneric} disabled={!genericId}>
          Add
        </button>
      </div>
    </>
  );

  return (
    <Page
      title={id ? "Edit reservation" : "New reservation"}
      actions={
        <>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" type="button" onClick={() => void save()} disabled={saving || !complete}>
            Save
          </button>
          <button type="button" onClick={() => guard(() => navigate(back))}>
            Cancel
          </button>
        </>
      }
    >
      <label>
        <span>Event</span>
        <input value={values.event} onChange={(e) => set({ event: e.target.value })} autoComplete="off" required />
      </label>
      <div className="row">
        <label className="tight">
          <span>Starts</span>
          <input type="date" value={values.starts} onChange={(e) => set({ starts: e.target.value })} required />
        </label>
        <label className="tight">
          <span>Ends</span>
          <input type="date" value={values.ends} onChange={(e) => set({ ends: e.target.value })} required />
        </label>
      </div>

      {/* At a desk the list is beside the ways of adding to it, not above them (NFR-USE-10). */}
      {wide ? (
        <div className="two-col">
          <div>
            {gearList}
            {quantities}
          </div>
          <div>
            {addItem}
            {addQuantity}
          </div>
        </div>
      ) : (
        <>
          {gearList}
          {addItem}
          {quantities}
          {addQuantity}
        </>
      )}
    </Page>
  );
}
