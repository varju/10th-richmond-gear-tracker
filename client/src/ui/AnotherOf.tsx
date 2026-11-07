import { useMemo, useState } from "react";
import { addUnit, bindCode } from "../lib/actions";
import { displayName, homeLabel, nextNumber, recentGenerics, unlabelledUnits } from "../lib/inventory";
import { back } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { Page } from "./Page";

/**
 * Another unit of something we have several of, for the code just scanned
 * (FR-INV-24, S-BOOT-03). One list, most recently labelled first, with a
 * search for when it is long. A tap puts the code on the lowest-numbered unit
 * still waiting for one (FR-INV-54); with none waiting it makes the unit with
 * the next number and the generic's home first. The number can be typed first,
 * for gear that already has one written on it: a waiting unit of that number
 * takes the code, a free number makes a new unit.
 */
export function AnotherOf({ store, code }: { store: Store; code: string }) {
  useStore(store);
  const [query, setQuery] = useState("");
  const [number, setNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const state = store.state;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Every keystroke re-renders; recentGenerics walks every item, so it is done once per state
  // change rather than once per keystroke.
  const recent = useMemo(() => recentGenerics(state, Infinity), [state]);
  const waiting = useMemo(() => unlabelledUnits(state), [state]);
  const typed = number.trim();

  /** The unit that will take the code, if one is waiting. */
  function target(genericId: string) {
    const units = waiting.get(genericId) ?? [];
    return typed ? units.find((u) => u.number === typed) : units[0];
  }
  const results = recent.filter((g) => {
    const hay = displayName(state, g).toLowerCase();
    return words.every((w) => hay.includes(w));
  });

  async function pick(genericId: string) {
    try {
      const id = target(genericId)?.id ?? (await addUnit(store, genericId, typed || undefined));
      await bindCode(store, code, id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add it");
      return;
    }
    back("/scan");
  }

  return (
    <Page title="Add a unit of…" back={`/g/${code}`}>
      <input
        aria-label="Search"
        placeholder="Search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
      />
      <label>
        <span>Number</span>
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="The next one"
          autoComplete="off"
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="rows">
        {results.map((g) => (
          <li key={g.id}>
            <button type="button" className="row" onClick={() => void pick(g.id)}>
              <span>{displayName(state, g)}</span>
              <span className="muted">
                {[
                  target(g.id) ? `#${target(g.id)!.number} · no code yet` : `#${typed || nextNumber(state, g.id)}`,
                  homeLabel(state, g),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          </li>
        ))}
        {results.length === 0 && <li className="muted">Nothing we have several of matches.</li>}
      </ul>
    </Page>
  );
}
