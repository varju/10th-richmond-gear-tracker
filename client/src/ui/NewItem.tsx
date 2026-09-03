import { useRef, useState } from "react";
import { addUnit, bindCode, createGeneric, createItem, createUnit, type ItemInput } from "../lib/actions";
import { categories, displayName, item, nextNumber, numberTaken } from "../lib/inventory";
import { back, navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useUnsaved } from "../lib/unsaved";
import { EMPTY_ITEM, HomeFields, ItemFields, SEVERAL } from "./ItemFields";
import { CONFIRM_MS, useFlash } from "./MoveActions";
import { Page } from "./Page";

interface Props {
  store: Store;
  /** A freshly scanned, unassigned code to put on the new item (S-BOOT-03). */
  code: string | null;
}

/** The categories a new item starts with: this device's last ones, for those that still exist (FR-SET-07). */
function rememberedCategories(store: Store): string[] {
  const live = new Set(categories(store.state).map((c) => c.id));
  return (store.meta.last_category_ids ?? []).filter((id) => live.has(id));
}

export function NewItem({ store, code }: Props) {
  const initial = { ...EMPTY_ITEM, category_ids: rememberedCategories(store) };
  const [values, setValues] = useState<ItemInput>(initial);
  // What Save last left behind. Anything typed since is a draft; leaving asks first.
  const [baseline, setBaseline] = useState<ItemInput>(initial);
  const [several, setSeveral] = useState(false);
  const [again, setAgain] = useState(false);
  const [keep, setKeep] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, flash] = useFlash(CONFIRM_MS);
  const nameRef = useRef<HTMLInputElement>(null);
  const name = (values.name ?? "").trim();
  const dirty = several || (Object.keys(values) as (keyof ItemInput)[]).some((k) => values[k] !== baseline[k]);
  useUnsaved(dirty, { save: () => create().then(() => true), canSave: name !== "" });

  /** Returns what the walk should open next: the new generic, or the thing the code went on. */
  async function create(): Promise<string> {
    setSaving(true);
    try {
      let id: string;
      if (several) {
        // A name several things share, and the one in hand as its first unit (FR-INV-26, S-BOOT-03).
        const genericId = await createGeneric(store, values);
        if (!code) id = genericId;
        else {
          const unitId = await addUnit(store, genericId);
          await bindCode(store, code, unitId);
          id = unitId;
        }
      } else {
        id = await createItem(store, values);
        if (code) await bindCode(store, code, id);
      }
      // So a run of tents costs no taps: the next new item starts with this one's categories.
      const current = values.category_ids ?? [];
      const remembered = store.meta.last_category_ids ?? [];
      const same = current.length === remembered.length && current.every((catId) => remembered.includes(catId));
      if (!same) await store.setMeta({ last_category_ids: current.length ? current : undefined });
      return id;
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const what = name;
    const id = await create();
    // A code came from the scanner, so the walk goes back to it whatever the checkbox says.
    if (code || !again) {
      if (code) back("/scan");
      else navigate(`/items/${id}`, true);
      return;
    }
    const next = keep ? values : { ...EMPTY_ITEM, category_ids: values.category_ids ?? [] };
    setValues(next);
    setBaseline(next);
    setSeveral(false);
    flash(`Saved · ${what}`);
    // The name is the one field that must differ; the cursor lands on it, ready to be typed over.
    nameRef.current?.select();
  }

  return (
    <Page
      title="New item"
      back={code ? "/scan" : "/"}
      actions={
        <button className="primary" type="button" onClick={save} disabled={saving || name === ""}>
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
      <ItemFields store={store} values={values} onChange={setValues} nameRef={nameRef} generic={several} />
      <label className="check">
        <input type="checkbox" checked={several} onChange={(e) => setSeveral(e.target.checked)} />
        <span>{SEVERAL}</span>
      </label>
      <p className="muted small check-hint">
        {several
          ? code
            ? "Saves the name, and this one as #1. The next scan offers another."
            : "Saves the name on its own. Units come later, one per code."
          : "Tick this for gear the group has more than one of, like tents."}
      </p>
      {!code && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={again}
              onChange={(e) => {
                setAgain(e.target.checked);
                if (!e.target.checked) setKeep(false);
              }}
            />
            <span>Add another after saving</span>
          </label>
          {again && (
            <label className="check">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              <span>Copy values above</span>
            </label>
          )}
        </>
      )}
    </Page>
  );
}

/**
 * One more of a generic (FR-INV-22, FR-INV-23). The number is the next free one
 * and can be changed, because the gear may already have a number written on it.
 * The home starts at the generic's (FR-INV-29).
 */
export function NewUnit({ store, parent, code }: Props & { parent: string }) {
  const state = store.state;
  const generic = item(state, parent);
  const [number, setNumber] = useState(() => nextNumber(state, parent));
  const [nickname, setNickname] = useState("");
  const [home, setHome] = useState(() => ({
    home_location_id: generic?.home_location_id ?? null,
    sub_location: generic?.sub_location ?? "",
  }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const n = number.trim();
  const taken = n !== "" && numberTaken(state, parent, n);
  const canSave = n !== "" && !taken;
  useUnsaved(nickname.trim() !== "", { save: () => save().then(() => true), canSave });

  if (!generic?.generic) {
    return (
      <Page title="Not found" back="/">
        <p>No generic item with that id. It may not have synced to this device yet.</p>
      </Page>
    );
  }

  async function save(): Promise<boolean> {
    if (!canSave) return false;
    setSaving(true);
    try {
      const id = await createUnit(store, { parent_id: parent, number: n, nickname: nickname.trim() || null, ...home });
      if (code) {
        await bindCode(store, code, id);
        back("/scan");
      } else navigate(`/items/${id}`, true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save it");
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page
      title="New unit"
      back={code ? "/scan" : `/items/${parent}`}
      actions={
        <button className="primary" type="button" onClick={() => void save()} disabled={saving || !canSave}>
          Save
        </button>
      }
    >
      <h2 className="item-title">{displayName(state, generic)}</h2>
      {code && (
        <p className="notice">
          Code <code>{code}</code> will go on this one.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label>
        <span>Number</span>
        {/* Text, not a number field: the gear may be labelled "A" or "3b" (FR-INV-23). */}
        <input value={number} autoFocus autoComplete="off" onChange={(e) => setNumber(e.target.value)} />
      </label>
      {taken && <p className="error">#{n} is already used here. Pick another.</p>}
      <label>
        <span>Nickname (optional)</span>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="e.g. patched fly"
          autoComplete="off"
        />
      </label>
      <HomeFields store={store} {...home} onChange={(patch) => setHome({ ...home, ...patch })} />
    </Page>
  );
}
