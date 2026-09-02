import { useState } from "react";
import { type OpenConflict, openConflicts, reviewConflict } from "../lib/conflicts";
import { displayName } from "../lib/inventory";
import { checkIn } from "../lib/movement";
import { addNote } from "../lib/notes";
import type { Movement, State } from "../lib/replay";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { localMinute } from "../lib/time";
import { guard, useUnsaved } from "../lib/unsaved";
import { useStore } from "../useStore";
import { userName } from "./labels";
import { Page } from "./Page";

/** Two check-outs the machine would not choose between, for a person to settle (FR-OFF-10). */
export function Conflicts({ store }: { store: Store }) {
  useStore(store);
  const open = openConflicts(store.state);
  return (
    <Page title="Conflicts" back="/">
      {open.length === 0 ? (
        <p>No conflicts.</p>
      ) : (
        <>
          <p className="muted">Two phones checked out the same item with no check-in between. Say what is true.</p>
          {open.map((c) => (
            <ConflictCard key={c.item.id} store={store} conflict={c} />
          ))}
        </>
      )}
    </Page>
  );
}

/** "Bob · checked out by Alice · Spring camp · 2026-09-01 14:02 · device …4F2A". */
export function describeVersion(state: State, m: Movement): string {
  const holder = userName(state, m.holder_id as string | null);
  const actor = userName(state, m.actor_id);
  const by = holder === actor ? `checked out by ${actor}` : `${holder} · checked out by ${actor}`;
  return [by, typeof m.event === "string" ? m.event : "", localMinute(m.at), `device …${m.device_id.slice(-4)}`]
    .filter(Boolean)
    .join(" · ");
}

function ConflictCard({ store, conflict }: { store: Store; conflict: OpenConflict }) {
  const { item: it, earlier, later } = conflict;
  const state = store.state;
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A typed note only makes sense with a decision, so leaving asks but cannot save it.
  useUnsaved(note !== null && note.trim() !== "");

  async function settle(act: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await act();
      if (note?.trim()) await addNote(store, { entity_type: "item", entity_id: it.id }, note);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record that");
      return;
    } finally {
      setBusy(false);
    }
    setNote(null);
  }

  return (
    <section className="conflict" aria-label={displayName(state, it)}>
      <button className="link" type="button" onClick={() => guard(() => navigate(`/items/${it.id}`))}>
        {displayName(state, it)}
      </button>
      <ol className="versions">
        <li>{describeVersion(state, earlier)}</li>
        <li>{describeVersion(state, later)}</li>
      </ol>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note !== null ? (
        <textarea
          aria-label="Note"
          rows={2}
          autoFocus
          placeholder="e.g. Bob handed it to Carol at the hall"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      ) : (
        <button type="button" className="minor" onClick={() => setNote("")}>
          Add note
        </button>
      )}
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => settle(() => checkIn(store, it.id))}>
          It is back
        </button>
        <button type="button" disabled={busy} onClick={() => settle(() => reviewConflict(store, it.id))}>
          Keep: {userName(state, later.holder_id as string | null)} has it
        </button>
      </div>
    </section>
  );
}
