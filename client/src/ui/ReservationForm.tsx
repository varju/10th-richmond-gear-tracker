import { Fragment, useEffect, useState } from "react";
import { homeLabel, nameOf, rows, type Row } from "../lib/inventory";
import {
  conflicts,
  createReservation,
  nearby,
  nearbyLabel,
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

/**
 * A quantity, typed in place (FR-RES-13): an integer of 1 or more. Its own text lets a clear and
 * a fresh digit read as one keystroke, not appended to whatever the model last held.
 */
function QuantityField({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      type="number"
      min={1}
      inputMode="numeric"
      style={{ width: "4em" }}
      aria-label={label}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number.parseInt(e.target.value, 10);
        if (Number.isInteger(n) && n >= 1) onChange(n);
      }}
    />
  );
}

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

/**
 * Event, dates, and gear from one search box (FR-RES-01, FR-RES-13). A unit never matches; its
 * generic does, and is added as a quantity line. A single item is added as itself. Units already
 * on the reservation (scanned on, FR-RES-07) still show, and can be removed here. New, edit and
 * duplicate.
 */
export function ReservationForm({ store, id, from }: Props) {
  useStore(store);
  const [values, setValues] = useState<ReservationInput>(() => initial(store, id, from));
  const [start] = useState(values);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const wide = useWide();
  const state = store.state;
  const set = (patch: Partial<ReservationInput>) => setValues((v) => ({ ...v, ...patch }));

  const complete = values.event.trim() !== "" && values.starts !== "" && values.ends !== "";
  const dirty = JSON.stringify(values) !== JSON.stringify(start);
  useUnsaved(dirty, { save, canSave: complete });

  const back = id ? `/reservations/${id}` : "/reservations";
  const near = nearby(state, values, id);

  async function save(): Promise<boolean> {
    if (!complete) return false;
    if (values.ends < values.starts) {
      setError("It ends before it starts.");
      return false;
    }
    // Blocked here, on this device's state (FR-RES-05). Two devices offline can both save; the page names the clash.
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

  const results: Row[] = query.trim()
    ? rows(state, { query })
        .filter((row) =>
          row.kind === "single"
            ? !values.items.includes(row.item.id)
            : !values.generics.some((g) => g.item_id === row.item.id),
        )
        .slice(0, 8)
    : [];

  function addResult(row: Row) {
    if (row.kind === "single") set({ items: [...values.items, row.item.id] });
    else set({ generics: [...values.generics, { item_id: row.item.id, quantity: 1 }] });
    setQuery("");
  }

  function setQuantity(itemId: string, quantity: number) {
    set({ generics: values.generics.map((g) => (g.item_id === itemId ? { ...g, quantity } : g)) });
  }

  const gearList = (
    <>
      <h3 className="section">Gear</h3>
      {values.items.length === 0 && values.generics.length === 0 && <p className="muted">Nothing added yet.</p>}
      <ul className="names">
        {values.items.map((itemId) => {
          const note = near[itemId];
          return (
            <Fragment key={itemId}>
              <li className="row">
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
              {note && <li className="muted small">{nearbyLabel(note)}</li>}
            </Fragment>
          );
        })}
        {values.generics.map((g) => {
          const note = near[g.item_id];
          return (
            <Fragment key={g.item_id}>
              <li className="row">
                <span className="name">{nameOf(state, g.item_id)}</span>
                <QuantityField
                  value={g.quantity}
                  onChange={(n) => setQuantity(g.item_id, n)}
                  label={`How many ${nameOf(state, g.item_id)}`}
                />
                <button
                  className="small"
                  type="button"
                  onClick={() => set({ generics: values.generics.filter((x) => x.item_id !== g.item_id) })}
                  aria-label={`Remove ${nameOf(state, g.item_id)}`}
                >
                  Remove
                </button>
              </li>
              {note && <li className="muted small">{nearbyLabel(note)}</li>}
            </Fragment>
          );
        })}
      </ul>
    </>
  );

  const addItem = (
    <>
      <input
        aria-label="Add gear"
        placeholder="Search gear to add"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
      />
      {results.length > 0 && (
        <ul className="rows">
          {results.map((row) => (
            <li key={row.item.id}>
              <button type="button" className="row" onClick={() => addResult(row)}>
                <span>{row.name}</span>
                <span className="muted">{row.kind === "single" ? homeLabel(state, row.item) : "so many"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
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

      {/* At a desk the list is beside the way of adding to it, not above it (NFR-USE-10). */}
      {wide ? (
        <div className="two-col">
          <div>{gearList}</div>
          <div>{addItem}</div>
        </div>
      ) : (
        <>
          {gearList}
          {addItem}
        </>
      )}
    </Page>
  );
}
