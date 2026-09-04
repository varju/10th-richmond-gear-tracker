import { useState } from "react";
import type { RefObject } from "react";
import { createCategory, type ItemInput } from "../lib/actions";
import { categories, locations, subLocations } from "../lib/inventory";
import type { Store } from "../lib/store";

interface Props {
  store: Store;
  values: ItemInput;
  onChange: (values: ItemInput) => void;
  /** So a screen can put the cursor back on the name. */
  nameRef?: RefObject<HTMLInputElement | null>;
  /** A generic: its home is where new units start (FR-INV-29). */
  generic?: boolean;
}

export const EMPTY_ITEM: ItemInput = {
  name: "",
  description: "",
  home_location_id: null,
  sub_location: "",
  purchase_date: "",
  category_ids: [],
};

/** The tick that turns one item into a name several things share (FR-INV-21, FR-INV-26). */
export const SEVERAL = "We have several of these";

/** The fields of an item, for creating and editing. The parent owns the values and the Save button. */
export function ItemFields({ store, values, onChange, nameRef, generic }: Props) {
  const state = store.state;
  const set = (patch: Partial<ItemInput>) => onChange({ ...values, ...patch });
  const cats = categories(state);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const tickedIds = values.category_ids ?? [];
  const tickedNames = cats.filter((c) => tickedIds.includes(c.id)).map((c) => c.name);

  /** Ticks an existing category of the same name (case-insensitive) rather than making a second one. */
  async function addCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    const existing = cats.find((c) => c.name.toLowerCase() === name.toLowerCase());
    const id = existing ? existing.id : await createCategory(store, name);
    const ids = values.category_ids ?? [];
    if (!ids.includes(id)) set({ category_ids: [...ids, id] });
    setNewCategoryName("");
    setAddingCategory(false);
  }

  return (
    <>
      <label>
        <span>Name</span>
        <input
          ref={nameRef}
          value={values.name ?? ""}
          onChange={(e) => set({ name: e.target.value })}
          required
          autoComplete="off"
        />
      </label>
      <HomeFields
        store={store}
        home_location_id={values.home_location_id ?? null}
        sub_location={values.sub_location ?? ""}
        onChange={set}
        label={generic ? "Default home" : "Home location"}
      />
      <details className="fold categories-fold">
        <summary>Categories · {tickedNames.length > 0 ? tickedNames.join(", ") : "None"}</summary>
        <fieldset className="categories" aria-label="Categories">
          {cats.map((c) => {
            const ids = values.category_ids ?? [];
            return (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={ids.includes(c.id)}
                  onChange={(e) =>
                    set({ category_ids: e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id) })
                  }
                />
                <span>{c.name}</span>
              </label>
            );
          })}
          {addingCategory ? (
            <div className="row">
              <input
                aria-label="New category"
                placeholder="New category"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void addCategory())}
                autoComplete="off"
                autoFocus
              />
              <button
                className="small"
                type="button"
                onClick={() => void addCategory()}
                disabled={!newCategoryName.trim()}
              >
                Add
              </button>
              <button
                className="small"
                type="button"
                onClick={() => {
                  setAddingCategory(false);
                  setNewCategoryName("");
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button className="small" type="button" onClick={() => setAddingCategory(true)}>
              New category…
            </button>
          )}
        </fieldset>
      </details>
      <label>
        <span>Description</span>
        <textarea value={values.description ?? ""} onChange={(e) => set({ description: e.target.value })} rows={3} />
      </label>
      <label>
        <span>Bought on</span>
        <input
          type="date"
          value={values.purchase_date ?? ""}
          onChange={(e) => set({ purchase_date: e.target.value })}
          autoComplete="off"
        />
      </label>
    </>
  );
}

interface HomeProps {
  store: Store;
  home_location_id: string | null;
  sub_location: string;
  onChange: (patch: { home_location_id?: string | null; sub_location?: string }) => void;
  /** "Home location", or "Default home" on a generic (FR-INV-29). */
  label?: string;
}

/** Where a thing belongs: a location from the list, and a free-text shelf (FR-INV-02, FR-SET-03). */
export function HomeFields({ store, home_location_id, sub_location, onChange, label = "Home location" }: HomeProps) {
  const state = store.state;
  const suggestions = subLocations(state, home_location_id ?? undefined);
  return (
    <>
      <label>
        <span>{label}</span>
        <select value={home_location_id ?? ""} onChange={(e) => onChange({ home_location_id: e.target.value || null })}>
          <option value="">None</option>
          {locations(state).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Shelf</span>
        <input
          list="sub-locations"
          value={sub_location}
          onChange={(e) => onChange({ sub_location: e.target.value })}
          autoComplete="off"
        />
        <datalist id="sub-locations">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>
    </>
  );
}
