import { useState } from "react";
import { countItems, type Filter, homeLabel, items, rows } from "../lib/inventory";
import { openRepairs } from "../lib/repairs";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { Filters } from "./Filters";
import { plural, statusLabel, syncLabel } from "./labels";
import { Sections } from "./Sections";

interface Props {
  store: Store;
}

/** Home: the list, searched as you type, with the scanner one tap away (FR-INV-07). */
export function Inventory({ store }: Props) {
  useStore(store);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({});
  const state = store.state;
  const list = rows(state, { ...filter, query });
  const empty = items(state).length === 0;

  return (
    <>
      <header>
        <h1>Gear Tracker</h1>
        <button className="corner" type="button" onClick={() => navigate("/settings")} aria-label="Settings">
          ⚙
        </button>
      </header>
      <main>
        <p className="muted small">
          {plural(countItems(list), "item")}
          {store.meta.last_sync_at !== undefined && ` · ${syncLabel(store.meta.last_sync_at, Date.now(), false, null)}`}
        </p>
        <Sections store={store} layout="row" />
        {empty ? (
          <p>Nothing here yet. Scan a code or add a new item.</p>
        ) : (
          <>
            <Filters store={store} filter={filter} onChange={setFilter} />
            <ul className="items">
              {list.map((row) => (
                <li key={row.item.id}>
                  <button className="item" type="button" onClick={() => navigate(`/items/${row.item.id}`)}>
                    <span>
                      <span className="item-name">{row.name}</span>
                      {row.kind === "single" && openRepairs(state, row.item.id).length > 0 && (
                        <span className="badge">Repair</span>
                      )}
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
              ))}
            </ul>
          </>
        )}
      </main>
      <div className="actions">
        <label className="tight">
          <span>Search</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        </label>
        <div className="row">
          <button className="primary" type="button" onClick={() => navigate("/scan")}>
            Scan
          </button>
          <button type="button" onClick={() => navigate("/items/new")}>
            New item
          </button>
        </div>
      </div>
    </>
  );
}
