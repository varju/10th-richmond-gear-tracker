import { useState } from "react";
import { bindCode, createItem, type ItemInput } from "../lib/actions";
import { locations } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { EMPTY_ITEM, ItemFields } from "./ItemFields";
import { useUnsaved } from "../lib/unsaved";
import { Page } from "./Page";

interface Props {
  store: Store;
  /** A freshly scanned, unassigned code to put on the new item (S-BOOT-03). */
  code: string | null;
}

const LAST_LOCATION = "last-location";

/** On a labelling walk every item goes in the same locker, so the last home is the default. */
function lastLocation(store: Store): string | null {
  let id: string | null = null;
  try {
    id = window.localStorage.getItem(LAST_LOCATION);
  } catch {
    // Storage blocked. No default, nothing worse.
  }
  return id && locations(store.state).some((l) => l.id === id) ? id : null;
}

function rememberLocation(id: string | null | undefined) {
  try {
    if (id) window.localStorage.setItem(LAST_LOCATION, id);
    else window.localStorage.removeItem(LAST_LOCATION);
  } catch {
    // Same as above.
  }
}

export function NewItem({ store, code }: Props) {
  const [values, setValues] = useState<ItemInput>(() => ({ ...EMPTY_ITEM, home_location_id: lastLocation(store) }));
  const [saving, setSaving] = useState(false);
  // The home is prefilled from last time; typing anything else is a draft (back asks before losing it).
  const dirty = Object.entries(values).some(
    ([k, v]) => k !== "home_location_id" && v !== EMPTY_ITEM[k as keyof ItemInput],
  );
  useUnsaved(dirty, { save: () => create().then(() => true), canSave: values.name.trim() !== "" });

  async function create(): Promise<string> {
    setSaving(true);
    try {
      const id = await createItem(store, values);
      rememberLocation(values.home_location_id);
      if (code) await bindCode(store, code, id);
      return id;
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const id = await create();
    navigate(code ? "/scan" : `/items/${id}`, true);
  }

  return (
    <Page
      title="New item"
      back={code ? "/scan" : "/"}
      actions={
        <button className="primary" type="button" onClick={save} disabled={saving || values.name.trim() === ""}>
          Save
        </button>
      }
    >
      {code && (
        <p className="notice">
          Code <code>{code}</code> will go on this item.
        </p>
      )}
      <ItemFields store={store} values={values} onChange={setValues} />
    </Page>
  );
}
