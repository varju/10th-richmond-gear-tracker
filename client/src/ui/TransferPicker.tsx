import { useMemo, useState } from "react";
import type { Item } from "../lib/inventory";
import type { Store } from "../lib/store";
import { transferChoices } from "../lib/transfers";
import { useShell } from "../shell";

/**
 * Who to transfer gear to (FR-OUT-26): any active member but the holder and the signed-in person,
 * who has Take over instead. Those they transferred to lately come first (FR-OUT-28). From the
 * local user list and log, so it works offline.
 */
export function TransferPicker({
  store,
  it,
  busy,
  onPick,
  onCancel,
}: {
  store: Store;
  it: Item;
  busy: boolean;
  onPick: (userId: string) => void;
  onCancel: () => void;
}) {
  const { now } = useShell();
  const [query, setQuery] = useState("");
  const me = store.meta.user?.id;
  const q = query.trim().toLowerCase();
  // The log scan and sort once per change to the store (store.version), not once per keystroke.
  const choices = useMemo(
    () => transferChoices(store.state, me ? store.eventsBy(me) : [], me, it.holder_id, now()),
    [store, store.version, me, it.holder_id, now],
  );
  const people = choices.filter((u) => !q || u.name.toLowerCase().includes(q));

  return (
    <section className="transfer-picker" aria-label="Transfer to">
      <input
        aria-label="Transfer to"
        placeholder="Name"
        autoFocus
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {people.length === 0 ? (
        <p className="muted">Nobody matches.</p>
      ) : (
        <ul className="rows">
          {people.slice(0, 8).map((u) => (
            <li key={u.id}>
              <button type="button" className="row" disabled={busy} onClick={() => onPick(u.id)}>
                <span>{u.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}
