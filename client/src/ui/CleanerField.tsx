import { useMemo } from "react";
import { cleanerKey } from "../lib/replay";
import { knownCleanerNames } from "../lib/movement";
import type { Store } from "../lib/store";

/**
 * Who is taking the gear home with someone (FR-OUT-46): a name, required, with the names this phone
 * has seen lately offered as you type (FR-OUT-48). They come from the local log, so other
 * Scouters' names are here after the last sync and the list works offline.
 */
export function CleanerField({
  store,
  value,
  onChange,
  disabled,
  autoFocus = true,
}: {
  store: Store;
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  // The log scan once per change to the store, not once per keystroke.
  const known = useMemo(() => knownCleanerNames(store), [store, store.version]);
  const q = cleanerKey(value);
  const matches = known.filter((name) => cleanerKey(name) !== q && cleanerKey(name).includes(q)).slice(0, 6);

  return (
    <div className="cleaner-field">
      <label className="tight">
        <span>Taken home by</span>
        <input
          aria-label="Taken home by"
          placeholder="Name"
          autoComplete="off"
          autoFocus={autoFocus}
          required
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
        />
      </label>
      {matches.length > 0 && (
        <ul className="rows" aria-label="Names used lately">
          {matches.map((name) => (
            <li key={name}>
              <button type="button" className="row" disabled={disabled} onClick={() => onChange(name)}>
                <span>{name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
