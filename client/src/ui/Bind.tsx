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
import { Page } from "./Page";

/** Pick the existing item an unassigned code goes on (S-BOOT-05, FR-TAG-07). */
export function Bind({ store, code }: { store: Store; code: string }) {
  useStore(store);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<Item | null>(null);
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
        <p className="big code">{code}</p>
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

  function pick(target: Item) {
    if (currentCode(store.state, target.id)) setConfirm(target);
    else void bind(target);
  }

  const results = bindTargets(store.state, { query });

  return (
    <Page title="Put code on an item" back={`/g/${code}`}>
      <p className="muted">
        Code <span className="code">{code}</span>
      </p>
      <input
        aria-label="Search items"
        placeholder="Search items"
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setConfirm(null);
        }}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="rows">
        {results.map((it) => {
          const old = currentCode(store.state, it.id)?.id;
          return (
            <li key={it.id}>
              {confirm?.id === it.id ? (
                <div className="row confirm">
                  <span>
                    Replace its code <span className="code">{old}</span>?
                  </span>
                  <button type="button" className="primary" onClick={() => void bind(it)}>
                    Replace
                  </button>
                  <button type="button" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" className="row" onClick={() => pick(it)}>
                  <span>{displayName(store.state, it)}</span>
                  <span className="muted">{homeLabel(store.state, it)}</span>
                </button>
              )}
            </li>
          );
        })}
        {results.length === 0 && <li className="muted">No items match.</li>}
      </ul>
    </Page>
  );
}
