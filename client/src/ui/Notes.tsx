import { type FormEvent, useState } from "react";
import { addNote, correctNote, deleteNote, type EntityRef } from "../lib/notes";
import type { Note } from "../lib/replay";
import type { Store } from "../lib/store";
import { isoDate } from "../lib/time";
import { useUnsaved } from "../lib/unsaved";
import { userName } from "./labels";

/** Notes with an Edit beside each. A correction is appended; the original stays in the log (FR-OUT-16). */
export function NoteList({ store, on, notes }: { store: Store; on: EntityRef; notes: Note[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="notes">
      {notes.map((n) => (
        <NoteLine key={n.id} store={store} on={on} note={n} />
      ))}
    </ul>
  );
}

/** One note as a list row: the text, who and when, and an Edit. */
export function NoteLine({ store, on, note }: { store: Store; on: EntityRef; note: Note }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = draft?.trim() ?? "";
  useUnsaved(draft !== null && text !== "" && text !== note.text, { save: commit, canSave: text !== "" });

  async function commit(): Promise<boolean> {
    try {
      if (text && text !== note.text) await correctNote(store, on, note.id, text);
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
      {/* Two taps, because there is no undo on the screen (NFR-USE-07). */}
      <button
        type="button"
        className={confirming ? "minor warn" : "minor"}
        aria-label={confirming ? `Really delete “${note.text}”?` : `Delete “${note.text}”`}
        onClick={() => (confirming ? void deleteNote(store, on, note.id) : setConfirming(true))}
        onBlur={() => setConfirming(false)}
      >
        {confirming ? "Really?" : "Delete"}
      </button>
    </li>
  );
}

/** A note on the entity itself: an item, not one of its movements; or a comment on a ticket (FR-REP-06). */
export function AddNote({ store, on }: { store: Store; on: EntityRef }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft?.trim() ?? "";
  useUnsaved(text !== "", { save: commit });

  async function commit(): Promise<boolean> {
    if (text) await addNote(store, on, text);
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
