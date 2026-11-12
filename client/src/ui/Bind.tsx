import { useState } from "react";
import { bindCode } from "../lib/actions";
import {
  bindTargets,
  code as codeOf,
  codeStatus,
  currentCode,
  displayName,
  homeLabel,
  type Item,
  item,
  nameOf,
} from "../lib/inventory";
import { back, navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { ConfirmButton } from "./ConfirmButton";
import { Page } from "./Page";

/** Pick the existing item an unassigned code goes on (S-BOOT-05, FR-TAG-07). */
export function Bind({ store, code }: { store: Store; code: string }) {
  useStore(store);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const status = codeStatus(store.state, code);

  if (status !== "unassigned") {
    const owner = item(store.state, codeOf(store.state, code)?.item_id ?? "");
    return (
      <Page
        title="Put code on an item"
        back="/scan"
        actions={
          <button type="button" onClick={() => back("/scan")}>
            Back
          </button>
        }
      >
        <p className="muted">
          {status === "unknown"
            ? "Not one of our codes. If it was just printed, sync first."
            : `Already on ${owner ? nameOf(store.state, owner.id) : "another item"}.`}
        </p>
      </Page>
    );
  }

  async function bind(target: Item) {
    try {
      await bindCode(store, code, target.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not bind the code");
      return;
    }
    navigate(`/items/${target.id}`, true);
  }

  const label = (it: Item) => (
    <>
      <span>{displayName(store.state, it)}</span>
      <span className="muted">{homeLabel(store.state, it)}</span>
    </>
  );

  const results = bindTargets(store.state, { query });

  return (
    <Page title="Put code on an item" back={`/g/${code}`}>
      <input
        aria-label="Search items"
        placeholder="Search items"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="rows">
        {results.map((it) => (
          <li key={it.id}>
            {currentCode(store.state, it.id) ? (
              <ConfirmButton
                className="row"
                label={label(it)}
                confirmLabel={
                  <>
                    {label(it)}
                    <span className="ask">Add another QR code to it?</span>
                  </>
                }
                onConfirm={() => bind(it)}
              />
            ) : (
              <button type="button" className="row" onClick={() => void bind(it)}>
                {label(it)}
              </button>
            )}
          </li>
        ))}
        {results.length === 0 && <li className="muted">No items match.</li>}
      </ul>
    </Page>
  );
}
