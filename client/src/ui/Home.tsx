import { rows } from "../lib/inventory";
import { filterParams, withQuery } from "../lib/listUrl";
import { navigate, useRoute } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { ItemList } from "./ItemList";
import { Alerts, Sections } from "./Sections";

/**
 * Home at a locker: what someone came to do, and nothing else. Scanning is the
 * usual next move, search is the fallback for gear with no sticker (FR-OUT-02,
 * FR-OUT-07), and a new item is the labelling walk. Everything else folds away.
 */
export function Home({ store }: { store: Store }) {
  useStore(store);
  const route = useRoute();
  const query = route.query.get("q") ?? "";

  // Replace, not push: typing a search must not fill the back button with keystrokes.
  const show = (text: string) => navigate(withQuery("/", filterParams(text, {})), true);

  const list = query ? rows(store.state, { query }) : [];

  return (
    <>
      <header>
        <h1>Gear Tracker</h1>
        <button className="corner" type="button" onClick={() => navigate("/settings")} aria-label="Settings">
          ⚙
        </button>
      </header>
      <main>
        <Alerts store={store} />
        {query ? (
          list.length === 0 ? (
            <p>Nothing matches.</p>
          ) : (
            <ItemList store={store} list={list} />
          )
        ) : (
          <p className="muted">Scan a code, or search by name.</p>
        )}
        <details className="more">
          <summary>More</summary>
          <Sections store={store} layout="row" />
        </details>
      </main>
      <div className="actions">
        <button className="primary tall" type="button" onClick={() => navigate("/scan")}>
          Scan
        </button>
        <label className="tight">
          <span>Search</span>
          <input type="search" value={query} onChange={(e) => show(e.target.value)} autoComplete="off" />
        </label>
        <button type="button" onClick={() => navigate("/items/new")}>
          New item
        </button>
      </div>
    </>
  );
}
