import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { type Api, ApiError, type ImportPlan, type ImportResult, Offline } from "../lib/api";
import { plural } from "./labels";

interface Props {
  api: Api;
  /** Called after an import is applied, so the changed items reach this phone. */
  onDone: () => Promise<unknown>;
}

function describe(e: unknown): string {
  if (e instanceof Offline) return "Needs a connection.";
  if (e instanceof ApiError) return e.message;
  throw e;
}

const ROW_LIMIT = 50;

/**
 * Export the inventory to a spreadsheet, edit it, and import it back
 * (FR-RPT-03, FR-SET-11). Nothing is written until Apply: the preview is
 * built from the same check `apply` runs, so a bad row is caught before
 * anything changes.
 */
export function CsvTools({ api, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const lastUrl = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    };
  }, []);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const url = URL.createObjectURL(await api.exportCsv());
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
      lastUrl.current = url;
      // A synthetic anchor, clicked and discarded: one tap, and the blob never becomes a link the person has to find.
      const a = document.createElement("a");
      a.href = url;
      a.download = "inventory.csv";
      document.body.append(a);
      a.click();
      a.remove();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      const read = await file.text();
      const preview = await api.previewImport(read);
      setText(read);
      setPlan(preview);
    } catch (err) {
      setPlan(null);
      setError(describe(err));
    }
  }

  function cancel() {
    setText(null);
    setPlan(null);
    setError(null);
  }

  async function apply() {
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const applied = await api.applyImport(text);
      setResult(applied);
      setText(null);
      setPlan(null);
      if (input.current) input.current.value = "";
      await onDone();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  const canApply =
    plan !== null &&
    plan.errors.length === 0 &&
    plan.adds + plan.changes + plan.new_locations.length + plan.new_categories.length > 0;

  return (
    <>
      <p className="muted small">
        Download every item, edit it in a spreadsheet, and import it back. A row with an id changes that item; a row
        without one adds one. Nothing is written until you apply, and one bad row stops the whole file.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="button" onClick={download} disabled={busy}>
        Download inventory.csv
      </button>
      <label>
        <span>Import a CSV</span>
        <input ref={input} type="file" accept=".csv,text/csv" onChange={onFile} />
      </label>
      {plan && <PlanPreview plan={plan} />}
      {plan && (
        <div className="row">
          <button type="button" className="primary" disabled={!canApply || busy} onClick={apply}>
            Apply
          </button>
          <button type="button" onClick={cancel} disabled={busy}>
            Cancel
          </button>
        </div>
      )}
      {result && (
        <p className="notice" role="status">
          Added {result.added}, changed {result.changed}.
          {result.created_locations.length > 0 && ` Created ${plural(result.created_locations.length, "location")}.`}
          {result.created_categories.length > 0 && ` Created ${plural(result.created_categories.length, "category")}.`}
        </p>
      )}
    </>
  );
}

function PlanPreview({ plan }: { plan: ImportPlan }) {
  const shown = plan.rows.slice(0, ROW_LIMIT);
  const more = plan.rows.length - shown.length;

  return (
    <div className="notice" role="status">
      <p>
        {plan.adds} to add, {plan.changes} to change, {plan.unchanged} unchanged.
      </p>
      {plan.new_locations.length > 0 && <p className="muted small">New locations: {plan.new_locations.join(", ")}.</p>}
      {plan.new_categories.length > 0 && (
        <p className="muted small">New categories: {plan.new_categories.join(", ")}.</p>
      )}
      {shown.length > 0 && (
        <ul className="names" aria-label="Import changes">
          {shown.map((r) => (
            <li key={r.row}>
              Row {r.row}: {r.name}
              {r.changes.length > 0 && (
                <ul>
                  {r.changes.map((c) => (
                    <li key={c.field}>
                      {c.field}: was {c.old || "blank"} now {c.new || "blank"}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
          {more > 0 && <li className="muted small">…and {more} more.</li>}
        </ul>
      )}
      {plan.errors.length > 0 && (
        <ul className="error" aria-label="Import errors">
          {plan.errors.map((e, i) => (
            <li key={i}>
              Row {e.row}: {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
