import type { ItemInput } from "../lib/actions";
import { itemTypes, locations, subLocations } from "../lib/inventory";
import type { Store } from "../lib/store";

interface Props {
  store: Store;
  values: ItemInput;
  onChange: (values: ItemInput) => void;
}

export const EMPTY_ITEM: ItemInput = {
  name: "",
  description: "",
  home_location_id: null,
  sub_location: "",
  type_id: null,
  condition: "",
  purchase_date: "",
  price: "",
  supplier: "",
};

/** The fields of an item, for creating and editing. The parent owns the values and the Save button. */
export function ItemFields({ store, values, onChange }: Props) {
  const state = store.state;
  const set = (patch: Partial<ItemInput>) => onChange({ ...values, ...patch });
  const suggestions = subLocations(state, values.home_location_id ?? undefined);
  return (
    <>
      <label>
        <span>Name</span>
        <input value={values.name} onChange={(e) => set({ name: e.target.value })} required autoComplete="off" />
      </label>
      <label>
        <span>Home location</span>
        <select
          value={values.home_location_id ?? ""}
          onChange={(e) => set({ home_location_id: e.target.value || null })}
        >
          <option value="">None</option>
          {locations(state).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Sub-location</span>
        <input
          list="sub-locations"
          value={values.sub_location ?? ""}
          onChange={(e) => set({ sub_location: e.target.value })}
          autoComplete="off"
        />
        <datalist id="sub-locations">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>
      <label>
        <span>Type</span>
        <select value={values.type_id ?? ""} onChange={(e) => set({ type_id: e.target.value || null })}>
          <option value="">None</option>
          {itemTypes(state).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Condition</span>
        <input value={values.condition ?? ""} onChange={(e) => set({ condition: e.target.value })} autoComplete="off" />
      </label>
      <label>
        <span>Description</span>
        <textarea value={values.description ?? ""} onChange={(e) => set({ description: e.target.value })} rows={3} />
      </label>
      <div className="row">
        <label className="tight">
          <span>Bought on</span>
          <input
            type="date"
            value={values.purchase_date ?? ""}
            onChange={(e) => set({ purchase_date: e.target.value })}
            autoComplete="off"
          />
        </label>
        <label className="tight">
          <span>Price</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={0.01}
            value={values.price ?? ""}
            onChange={(e) => set({ price: e.target.value })}
            autoComplete="off"
          />
        </label>
      </div>
      <label>
        <span>Supplier</span>
        <input value={values.supplier ?? ""} onChange={(e) => set({ supplier: e.target.value })} autoComplete="off" />
      </label>
    </>
  );
}
