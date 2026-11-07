import { useEffect, useState } from "react";
import type { ItemInput } from "../lib/actions";
import type { Item } from "../lib/inventory";
import { parentOf } from "../lib/inventory";
import { refill, weigh } from "../lib/movement";
import type { Store } from "../lib/store";
import { ago } from "../lib/time";
import {
  amountLeft,
  leftLabel,
  readingIsStale,
  parseAmount,
  type Weight,
  WEIGHT_UNITS,
  type WeightUnit,
  weighing,
  weightLabel,
} from "../lib/weighing";

/** lb or kg, one tap each (FR-INV-62). */
function UnitSwitch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: WeightUnit;
  onChange: (unit: WeightUnit) => void;
}) {
  return (
    <div className="unit-switch" role="group" aria-label={label}>
      {WEIGHT_UNITS.map((u) => (
        <button key={u} type="button" className="small" aria-pressed={value === u} onClick={() => onChange(u)}>
          {u}
        </button>
      ))}
    </div>
  );
}

/** A number and its own unit, for the edit page. Blank, or a number that will not do, is no weight. */
function WeightBox({
  label,
  value,
  onChange,
  onValid,
  defaultUnit,
  positive,
}: {
  label: string;
  value: Weight | null | undefined;
  /** Called with a weight, or null for a blank box. Not called while the text is not a usable number. */
  onChange: (weight: Weight | null) => void;
  /** Says whether the text is usable, on every change. */
  onValid: (ok: boolean) => void;
  defaultUnit: WeightUnit;
  /** A capacity of zero would leave nothing to measure. */
  positive?: boolean;
}) {
  const [text, setText] = useState(value ? String(value.value) : "");
  const [unit, setUnit] = useState<WeightUnit>(value?.unit ?? defaultUnit);
  const blank = text.trim() === "";
  const n = parseAmount(text);
  const bad = !blank && (n === null || (positive === true && n === 0));
  function emit(nextText: string, nextUnit: WeightUnit) {
    const next = parseAmount(nextText);
    const empty = nextText.trim() === "";
    const ok = empty || (next !== null && !(positive && next === 0));
    onValid(ok);
    if (empty) onChange(null);
    else if (ok) onChange({ value: next!, unit: nextUnit });
  }
  return (
    <div className="weight-box">
      <label className="tight">
        <span>{label}</span>
        <input
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            emit(e.target.value, unit);
          }}
          autoComplete="off"
          aria-invalid={bad}
        />
      </label>
      {bad && (
        <p className="error" role="alert">
          {positive ? "A number above zero." : "A number of zero or more."}
        </p>
      )}
      <UnitSwitch
        label={`${label} unit`}
        value={unit}
        onChange={(u) => {
          setUnit(u);
          emit(text, u);
        }}
      />
    </div>
  );
}

/**
 * The weighing fields of the edit page (FR-INV-62, FR-INV-63): an empty weight, which a generic leaves to its
 * units, and a capacity, which a unit may leave to its generic.
 */
export function WeighFields({
  store,
  it,
  values,
  onChange,
  onValid,
}: {
  store: Store;
  it: Item;
  values: ItemInput;
  onChange: (values: ItemInput) => void;
  /** False while a box holds text that is not a usable weight, so the caller can hold Save. */
  onValid: (ok: boolean) => void;
}) {
  const [bad, setBad] = useState({ empty: false, capacity: false });
  const anyBad = bad.empty || bad.capacity;
  useEffect(() => onValid(!anyBad), [anyBad, onValid]);
  const generic = Boolean(it.generic);
  const inherited = parentOf(store.state, it)?.capacity;
  const set = (patch: Partial<ItemInput>) => onChange({ ...values, ...patch });
  return (
    <details className="fold" open={Boolean(values.empty_weight || values.capacity) || anyBad}>
      <summary>Weighed to see what is left</summary>
      {!generic && (
        <WeightBox
          label="Empty weight"
          value={values.empty_weight}
          defaultUnit="lb"
          onChange={(empty_weight) => set({ empty_weight })}
          onValid={(ok) => setBad((b) => ({ ...b, empty: !ok }))}
        />
      )}
      <WeightBox
        label="Capacity"
        value={values.capacity}
        defaultUnit={values.empty_weight?.unit ?? "lb"}
        positive
        onChange={(capacity) => set({ capacity })}
        onValid={(ok) => setBad((b) => ({ ...b, capacity: !ok }))}
      />
      <p className="muted small">
        {generic
          ? "Each unit sets its own empty weight. Its capacity is this one unless it has its own."
          : inherited
            ? `The weight of its full contents. Leave capacity empty to use the generic’s, ${weightLabel(inherited)}.`
            : "The weight of its full contents, such as the propane in a full tank."}
      </p>
    </details>
  );
}

/** One number and an lb/kg switch, with a button that takes it and optionally one that says Unknown (FR-INV-67). */
export function WeighEntry({
  unit,
  submitLabel,
  onSubmit,
  onUnknown,
  onCancel,
  busy,
  hint,
}: {
  /** What the switch starts on: the item's own unit. */
  unit: WeightUnit;
  submitLabel: string;
  onSubmit: (weight: Weight) => void;
  onUnknown?: () => void;
  onCancel: () => void;
  busy?: boolean;
  hint?: string;
}) {
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<WeightUnit>(unit);
  const amount = parseAmount(text);
  const submit = () => amount !== null && onSubmit({ value: amount, unit: chosen });
  return (
    <section className="weigh-entry" aria-label="Weigh">
      <div className="weight-box">
        <label className="tight">
          <span>Weight now</span>
          <input
            inputMode="decimal"
            value={text}
            autoFocus
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (!busy) submit();
            }}
          />
        </label>
        <UnitSwitch label="Weight unit" value={chosen} onChange={setChosen} />
      </div>
      {hint && <p className="muted small">{hint}</p>}
      <div className="row">
        <button type="button" className="primary" disabled={busy || amount === null} onClick={submit}>
          {submitLabel}
        </button>
        {onUnknown && (
          <button type="button" disabled={busy} onClick={onUnknown}>
            Unknown
          </button>
        )}
      </div>
      <button type="button" className="minor" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}

/** "Empty 18 lb, full 38 lb": what the person is weighing against. */
export function weighHint(store: Store, it: Item): string | undefined {
  const w = weighing(store.state, it);
  return w ? `Empty ${weightLabel(w.empty_weight)}, holds ${weightLabel(w.capacity)}.` : undefined;
}

/** The item page's "Left" line: what is left and when it was weighed, or that it was not (FR-INV-66). */
export function leftFact(store: Store, it: Item): string {
  const a = amountLeft(store.state, it);
  if (!a)
    return readingIsStale(store.state, it)
      ? it.status === "out"
        ? "Not weighed since it went out"
        : "Not weighed since it came back"
      : "Not weighed";
  return `${leftLabel(a)} · ${a.full ? "refilled" : "weighed"} ${ago(store.now() - a.at)}`;
}

/** Weigh and Refilled, on the page of an item that is weighed (FR-INV-64, FR-INV-65). */
export function WeighActions({ store, it }: { store: Store; it: Item }) {
  const [entering, setEntering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const w = weighing(store.state, it);
  if (!w) return null;

  async function run(act: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await act();
      setEntering(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record it");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="weigh-actions">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {entering ? (
        <WeighEntry
          unit={w.unit}
          submitLabel="Save weight"
          hint={weighHint(store, it)}
          busy={busy}
          onSubmit={(weight) => void run(() => weigh(store, it.id, weight))}
          onCancel={() => setEntering(false)}
        />
      ) : (
        <div className="row">
          <button type="button" onClick={() => setEntering(true)}>
            Weigh
          </button>
          <button type="button" disabled={busy} onClick={() => void run(() => refill(store, it.id))}>
            Refilled
          </button>
        </div>
      )}
    </div>
  );
}
