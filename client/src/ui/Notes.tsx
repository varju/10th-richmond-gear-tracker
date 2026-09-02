import { type FormEvent, useState } from "react";
import { addNote, correctNote } from "../lib/movement";
import type { Note } from "../lib/replay";
import type { Store } from "../lib/store";
import { isoDate } from "../lib/time";
import { useUnsaved } from "../lib/unsaved";
import { userName } from "./labels";

/** Notes with an Edit beside each. A correction is appended; the original stays in the log (FR-OUT-16). */
export function NoteList({ store, itemId, notes }: { store: Store; itemId: string; notes: Note[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="notes">
      {notes.map((n) => (
        <NoteLine key={n.id} store={store} itemId={itemId} note={n} />
      ))}
    </ul>
  );
}

function NoteLine({ store, itemId, note }: { store: Store; itemId: string; note: Note }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = draft?.trim() ?? "";
  useUnsaved(draft !== null && text !== "" && text !== note.text, { save: commit, canSave: text !== "" });

  async function commit(): Promise<boolean> {
    try {
      if (text && text !== note.text) await correctNote(store, itemId, note.id, text);
      setDraft(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the note");
      return false;
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    void commit();
  }

  if (draft !== null) {
    return (
      <li className="note">
        <form className="note-edit" onSubmit={save}>
          <input aria-label="Note text" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="minor primary">
            Save
          </button>
          <button type="button" className="minor" onClick={() => setDraft(null)}>
            Cancel
          </button>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      </li>
    );
  }
  return (
    <li className="note">
      <span className="note-text">{note.text}</span>
      <span className="muted small">
        {userName(store.state, note.actor_id)} · {isoDate(note.at)}
      </span>
      <button type="button" className="minor" onClick={() => setDraft(note.text)}>
        Edit
      </button>
    </li>
  );
}

/** A note on the item itself, not on a movement. */
export function AddNote({ store, itemId }: { store: Store; itemId: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft?.trim() ?? "";
  useUnsaved(text !== "", { save: commit });

  async function commit(): Promise<boolean> {
    if (text) await addNote(store, itemId, text);
    setDraft(null);
    return true;
  }

  function save(e: FormEvent) {
    e.preventDefault();
    void commit();
  }

  if (draft === null) {
    return (
      <button type="button" className="minor" onClick={() => setDraft("")}>
        Add note
      </button>
    );
  }
  return (
    <form className="note-edit" onSubmit={save}>
      <input aria-label="New note" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button type="submit" className="minor primary">
        Save
      </button>
      <button type="button" className="minor" onClick={() => setDraft(null)}>
        Cancel
      </button>
    </form>
  );
}
