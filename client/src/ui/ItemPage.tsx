import { useState } from "react";
import { type ItemInput, retireItem, unretireItem, updateItem } from "../lib/actions";
import { codesFor, homeLabel, item, typeName } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { isoDate } from "../lib/time";
import { useStore } from "../useStore";
import { ItemFields } from "./ItemFields";
import { statusLabel } from "./labels";
import { Page } from "./Page";

interface Props {
  store: Store;
  id: string;
}

/** One item: what it is, where it lives, who has it (FR-INV-09). */
export function ItemPage({ store, id }: Props) {
  useStore(store);
  const [editing, setEditing] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const state = store.state;
  const it = item(state, id);

  if (!it) {
    return (
      <Page title="Not found" back="/">
        <p>No item with that id. It may not have synced to this phone yet.</p>
      </Page>
    );
  }

  if (editing) {
    return (
      <EditItem
        store={store}
        id={id}
        initial={{
          name: it.name,
          description: it.description ?? "",
          home_location_id: it.home_location_id ?? null,
          sub_location: it.sub_location ?? "",
          type_id: it.type_id ?? null,
          condition: it.condition ?? "",
        }}
        onDone={() => setEditing(false)}
      />
    );
  }

  const codes = codesFor(state, id);
  const current = codes[0];

  async function retire() {
    if (!confirmRetire) {
      setConfirmRetire(true);
      return;
    }
    await retireItem(store, id);
    setConfirmRetire(false);
  }

  return (
    <Page
      title="Item"
      back="/"
      actions={
        <>
          <button className="primary" type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
          <div className="row">
            <button type="button" onClick={() => navigate(`/scan?for=${id}`)}>
              Replace code
            </button>
            {it.retired ? (
              <button type="button" onClick={() => unretireItem(store, id)}>
                Unretire
              </button>
            ) : (
              <button type="button" className={confirmRetire ? "warn" : ""} onClick={retire}>
                {confirmRetire ? "Really retire?" : "Retire"}
              </button>
            )}
          </div>
        </>
      }
    >
      <h2 className="item-title">
        {it.name}
        {it.retired && <span className="badge">Retired</span>}
      </h2>
      {it.retired && (
        <p className="notice" role="note">
          Retired. Cannot be checked out.
        </p>
      )}
      <dl className="facts">
        <dt>Status</dt>
        <dd>{statusLabel(state, it)}</dd>
        <dt>Home</dt>
        <dd>{homeLabel(state, it) || "—"}</dd>
        <dt>Type</dt>
        <dd>{typeName(state, it.type_id) || "—"}</dd>
        <dt>Condition</dt>
        <dd>{it.condition || "—"}</dd>
        <dt>Notes</dt>
        <dd className="prose">{it.description || "—"}</dd>
        <dt>Code</dt>
        <dd>
          {current ? <code>{current.id}</code> : "none"}
          {codes.length > 1 && <span className="muted"> · {codes.length - 1} replaced</span>}
        </dd>
        <dt>Added</dt>
        <dd>{it.added_at ? isoDate(it.added_at) : "—"}</dd>
        <dt>Modified</dt>
        <dd>{it.modified_at ? isoDate(it.modified_at) : "—"}</dd>
      </dl>
    </Page>
  );
}

function EditItem({
  store,
  id,
  initial,
  onDone,
}: {
  store: Store;
  id: string;
  initial: ItemInput;
  onDone: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await updateItem(store, id, values);
      onDone();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page
      title="Edit item"
      actions={
        <>
          <button className="primary" type="button" onClick={save} disabled={saving || values.name.trim() === ""}>
            Save
          </button>
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        </>
      }
    >
      <ItemFields store={store} values={values} onChange={setValues} />
    </Page>
  );
}
