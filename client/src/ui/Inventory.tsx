import { countItems, type Filter, items, rows } from "../lib/inventory";
import { filterParams, readFilter, withQuery } from "../lib/listUrl";
import { navigate, useRoute } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { Filters } from "./Filters";
import { ItemList } from "./ItemList";
import { plural, syncLabel } from "./labels";
import { Page } from "./Page";

interface Props {
  store: Store;
}

/** The whole list on a phone, searched and filtered (FR-INV-07, FR-INV-25). The desk gets a table instead. */
export function Inventory({ store }: Props) {
  useStore(store);
  const route = useRoute();
  const query = route.query.get("q") ?? "";
  const filter = readFilter(route.query);
  const state = store.state;

  // Replace, not push: typing a search must not fill the back button with keystrokes.
  const show = (text: string, next: Filter) => navigate(withQuery("/items", filterParams(text, next)), true);

  const list = rows(state, { ...filter, query });
  const empty = items(state).length === 0;

  return (
    <Page
      title="Inventory"
      back="/"
      actions={
        <>
          <label className="tight">
            <span>Search</span>
            <input type="search" value={query} onChange={(e) => show(e.target.value, filter)} autoComplete="off" />
          </label>
          <div className="row">
            <button className="primary" type="button" onClick={() => navigate("/scan")}>
              Scan
            </button>
            <button type="button" onClick={() => navigate("/items/new")}>
              New item
            </button>
          </div>
        </>
      }
    >
      <p className="muted small">
        {plural(countItems(list), "item")}
        {store.meta.last_sync_at !== undefined && ` · ${syncLabel(store.meta.last_sync_at, Date.now(), false, null)}`}
      </p>
      {empty ? (
        <p>Nothing here yet. Scan a code or add a new item.</p>
      ) : (
        <>
          <Filters store={store} filter={filter} onChange={(f) => show(query, f)} />
          <ItemList store={store} list={list} />
        </>
      )}
    </Page>
  );
}
