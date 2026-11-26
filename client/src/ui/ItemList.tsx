import { byCategory, categories, displayName, homeLabel, type Row } from "../lib/inventory";
import { openRepairs } from "../lib/repairs";
import type { Store } from "../lib/store";
import { useFolds } from "./folds";
import { countsLabel, leftNote, statusLabel } from "./labels";
import { RouteLink } from "./RouteLink";

/**
 * The phone's list of gear: one tappable row each, name and home. The home
 * screen shows it for a search, `/items` shows all of it. Grouped under a
 * category heading once the group has any (FR-SET-07); a flat list otherwise.
 * Each heading is a fold, so a locker looking for one category can collapse
 * the rest. Folds come back on Back; a search or filter opens them all again.
 */
export function ItemList({
  store,
  list,
  showUnits,
  narrowed,
}: {
  store: Store;
  list: Row[];
  showUnits?: boolean;
  narrowed: boolean;
}) {
  const state = store.state;
  const { folds, setFolds } = useFolds(narrowed);
  const categoryFolds = folds("categoryFolds");
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
      {byCategory(state, list).map((g) => {
        const id = g.category?.id ?? "";
        const open = categoryFolds[id] ?? true;
        return (
          <section key={id} aria-label={g.category?.name ?? "No category"}>
            <details
              className="cat"
              open={open}
              onToggle={(e) => {
                if (e.currentTarget.open !== open) setFolds("categoryFolds", [id], e.currentTarget.open);
              }}
            >
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
        );
      })}
    </>
  );
}

function ItemRow({ store, row, showUnits }: { store: Store; row: Row; showUnits?: boolean }) {
  const state = store.state;
  return (
    <li>
      <RouteLink className="item" to={`/items/${row.item.id}`}>
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
      </RouteLink>
      {showUnits && row.kind === "generic" && (
        <ul className="items nested">
          {row.units.map((u) => (
            <li key={u.id}>
              <RouteLink className="item" to={`/items/${u.id}`}>
                <span className="item-name">{displayName(state, u)}</span>
                <span className="muted small">
                  {[homeLabel(state, u), leftNote(state, u)].filter(Boolean).join(" · ")}
                </span>
              </RouteLink>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
