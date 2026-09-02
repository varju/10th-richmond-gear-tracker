import { useState } from "react";
import { InUse } from "../lib/actions";
import { useUnsaved } from "../lib/unsaved";

interface Named {
  id: string;
  name: string;
}

interface Props {
  /** Singular, lower case: "location". */
  noun: string;
  items: Named[];
  onAdd: (name: string) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
}

/** Locations: a list of names to add to, rename, or delete (FR-SET-02, FR-SET-05). */
export function NameList({ noun, items, onAdd, onRename, onDelete }: Props) {
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A name typed but not added, or a rename not saved, is a draft; leaving asks first.
  const original = editing ? items.find((n) => n.id === editing.id)?.name : undefined;
  useUnsaved(adding.trim() !== "", { save: () => add().then(() => true) });
  useUnsaved(editing !== null && editing.name.trim() !== original, {
    save: () => rename().then(() => true),
    canSave: Boolean(editing?.name.trim()),
  });

  async function remove(id: string) {
    setError(null);
    try {
      await onDelete(id);
    } catch (e) {
      if (e instanceof InUse) setError(`In use by ${e.names.join(", ")}. Move them first.`);
      else throw e;
    }
  }

  async function add() {
    if (!adding.trim()) return;
    await onAdd(adding);
    setAdding("");
  }

  async function rename() {
    if (!editing || !editing.name.trim()) return;
    await onRename(editing.id, editing.name);
    setEditing(null);
  }

  return (
    <>
      <ul className="names">
        {items.map((n) =>
          editing?.id === n.id ? (
            <li key={n.id} className="row">
              <input
                aria-label={`New name for ${n.name}`}
                value={editing.name}
                onChange={(e) => setEditing({ id: n.id, name: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void rename())}
                autoFocus
              />
              <button className="small" type="button" onClick={rename} aria-label={`Save ${n.name}`}>
                Save
              </button>
              <button className="small" type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </li>
          ) : (
            <li key={n.id} className="row">
              <span className="name">{n.name}</span>
              <button
                className="small"
                type="button"
                onClick={() => setEditing({ id: n.id, name: n.name })}
                aria-label={`Rename ${n.name}`}
              >
                Rename
              </button>
              <button className="small" type="button" onClick={() => remove(n.id)} aria-label={`Delete ${n.name}`}>
                Delete
              </button>
            </li>
          ),
        )}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <input
          aria-label={`New ${noun}`}
          placeholder={`New ${noun}`}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void add())}
          autoComplete="off"
        />
        <button className="small" type="button" onClick={add} disabled={!adding.trim()}>
          Add
        </button>
      </div>
    </>
  );
}
