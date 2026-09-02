import { useRef, useState } from "react";
import { bindCode, createItem, type ItemInput } from "../lib/actions";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useUnsaved } from "../lib/unsaved";
import { EMPTY_ITEM, ItemFields } from "./ItemFields";
import { CONFIRM_MS, useFlash } from "./MoveActions";
import { Page } from "./Page";

interface Props {
  store: Store;
  /** A freshly scanned, unassigned code to put on the new item (S-BOOT-03). */
  code: string | null;
}

export function NewItem({ store, code }: Props) {
  const [values, setValues] = useState<ItemInput>(EMPTY_ITEM);
  // What Save last left behind. Anything typed since is a draft; leaving asks first.
  const [baseline, setBaseline] = useState<ItemInput>(EMPTY_ITEM);
  const [again, setAgain] = useState(false);
  const [keep, setKeep] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, flash] = useFlash(CONFIRM_MS);
  const nameRef = useRef<HTMLInputElement>(null);
  const dirty = (Object.keys(values) as (keyof ItemInput)[]).some((k) => values[k] !== baseline[k]);
  useUnsaved(dirty, { save: () => create().then(() => true), canSave: values.name.trim() !== "" });

  async function create(): Promise<string> {
    setSaving(true);
    try {
      const id = await createItem(store, values);
      if (code) await bindCode(store, code, id);
      return id;
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const name = values.name.trim();
    const id = await create();
    // A code came from the scanner, so the walk goes back to it whatever the checkbox says.
    if (code || !again) {
      navigate(code ? "/scan" : `/items/${id}`, true);
      return;
    }
    const next = keep ? values : EMPTY_ITEM;
    setValues(next);
    setBaseline(next);
    flash(`Saved · ${name}`);
    // The name is the one field that must differ; the cursor lands on it, ready to be typed over.
    nameRef.current?.select();
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
      {saved && (
        <p className="confirmed" role="status">
          {saved}
        </p>
      )}
      {code && (
        <p className="notice">
          Code <code>{code}</code> will go on this item.
        </p>
      )}
      <ItemFields store={store} values={values} onChange={setValues} nameRef={nameRef} />
      {!code && (
        <>
          <label className="check">
            <input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} />
            <span>Add another after saving</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={keep} disabled={!again} onChange={(e) => setKeep(e.target.checked)} />
            <span>Keep these values as a template</span>
          </label>
        </>
      )}
    </Page>
  );
}
