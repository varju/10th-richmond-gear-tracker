import { byCategory, categories, homeLabel, type Row } from "../lib/inventory";
import { openRepairs } from "../lib/repairs";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { plural, statusLabel } from "./labels";

/**
 * The phone's list of gear: one tappable row each, name and home. The home
 * screen shows it for a search, `/items` shows all of it. Grouped under a
 * category heading once the group has any (FR-SET-07); a flat list otherwise.
 */
export function ItemList({ store, list }: { store: Store; list: Row[] }) {
  const state = store.state;
  if (categories(state).length === 0) {
    return (
      <ul className="items">
        {list.map((row) => (
          <ItemRow key={row.item.id} store={store} row={row} />
        ))}
      </ul>
    );
  }
  return (
    <>
      {byCategory(state, list).map((g) => (
        <section key={g.category?.id ?? ""} aria-label={g.category?.name ?? "No category"}>
          <h2 className="section">{g.category?.name ?? "No category"}</h2>
          <ul className="items">
            {g.rows.map((row) => (
              <ItemRow key={row.item.id} store={store} row={row} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function ItemRow({ store, row }: { store: Store; row: Row }) {
  const state = store.state;
  return (
    <li>
      <button className="item" type="button" onClick={() => navigate(`/items/${row.item.id}`)}>
        <span>
          <span className="item-name">{row.name}</span>
          {row.kind === "single" && openRepairs(state, row.item.id).length > 0 && <span className="badge">Repair</span>}
          {row.kind === "single" && row.item.missing && <span className="badge">Missing</span>}
        </span>
        <span className="muted small">
          {row.kind === "generic"
            ? `${plural(row.counts.total, "unit")} · ${row.counts.in} in`
            : [
                homeLabel(state, row.item),
                row.item.status === "out" && !row.item.missing ? statusLabel(state, row.item) : "",
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
      </button>
    </li>
  );
}
