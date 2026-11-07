import { byCategory, categories, displayName, homeLabel, type Row } from "../lib/inventory";
import { openRepairs } from "../lib/repairs";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { countsLabel, leftNote, statusLabel } from "./labels";

/**
 * The phone's list of gear: one tappable row each, name and home. The home
 * screen shows it for a search, `/items` shows all of it. Grouped under a
 * category heading once the group has any (FR-SET-07); a flat list otherwise.
 * Each heading is a fold, so a locker looking for one category can collapse
 * the rest.
 */
export function ItemList({ store, list, showUnits }: { store: Store; list: Row[]; showUnits?: boolean }) {
  const state = store.state;
  if (categories(state).length === 0) {
    return (
      <ul className="items">
        {list.map((row) => (
          <ItemRow key={row.item.id} store={store} row={row} showUnits={showUnits} />
        ))}
      </ul>
    );
  }
  return (
    <>
      {byCategory(state, list).map((g) => (
        <section key={g.category?.id ?? ""} aria-label={g.category?.name ?? "No category"}>
          <details className="cat" open>
            <summary>
              <h2 className="section">{g.category?.name ?? "No category"}</h2>
            </summary>
            <ul className="items">
              {g.rows.map((row) => (
                <ItemRow key={row.item.id} store={store} row={row} showUnits={showUnits} />
              ))}
            </ul>
          </details>
        </section>
      ))}
    </>
  );
}

function ItemRow({ store, row, showUnits }: { store: Store; row: Row; showUnits?: boolean }) {
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
          {row.kind !== "single"
            ? countsLabel(row)
            : [
                homeLabel(state, row.item),
                row.item.status === "out" && !row.item.missing ? statusLabel(state, row.item) : "",
                leftNote(state, row.item),
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
      </button>
      {showUnits && row.kind === "generic" && (
        <ul className="items nested">
          {row.units.map((u) => (
            <li key={u.id}>
              <button className="item" type="button" onClick={() => navigate(`/items/${u.id}`)}>
                <span className="item-name">{displayName(state, u)}</span>
                <span className="muted small">
                  {[homeLabel(state, u), leftNote(state, u)].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
