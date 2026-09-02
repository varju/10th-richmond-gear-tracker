import type { Filter } from "../lib/inventory";
import { locations, subLocations } from "../lib/inventory";
import type { Store } from "../lib/store";

interface Props {
  store: Store;
  filter: Filter;
  onChange: (f: Filter) => void;
}

/** Location, sub-location, status, retired. Folded away on a phone, in a row at a desk. */
export function FilterFields({ store, filter, onChange }: Props) {
  const state = store.state;
  const set = (patch: Partial<Filter>) => onChange({ ...filter, ...patch });
  return (
    <>
      <div className="row">
        <label className="tight">
          <span>Location</span>
          <select
            value={filter.location_id ?? ""}
            onChange={(e) =>
              set({
                location_id: e.target.value || undefined,
                sub_location: undefined,
              })
            }
          >
            <option value="">Any</option>
            {locations(state).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="tight">
          <span>Sub-location</span>
          <select
            value={filter.sub_location ?? ""}
            onChange={(e) => set({ sub_location: e.target.value || undefined })}
          >
            <option value="">Any</option>
            {subLocations(state, filter.location_id).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <label className="tight">
          <span>Status</span>
          <select
            value={filter.status ?? ""}
            onChange={(e) => set({ status: (e.target.value || undefined) as Filter["status"] })}
          >
            <option value="">Any</option>
            <option value="in">In</option>
            <option value="out">Out</option>
            <option value="missing">Missing</option>
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={Boolean(filter.retired)} onChange={(e) => set({ retired: e.target.checked })} />
        <span>Show retired</span>
      </label>
    </>
  );
}

/** The phone's version: out of the way until it is wanted. */
export function Filters(props: Props) {
  const active = Object.values(props.filter).filter(Boolean).length;
  return (
    <details className="filters">
      <summary>Filters{active > 0 && ` (${active})`}</summary>
      <FilterFields {...props} />
    </details>
  );
}
