import { useState } from "react";
import { rows } from "../lib/inventory";
import { filterParams, withQuery } from "../lib/listUrl";
import { navigate, useRoute } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { ItemList } from "./ItemList";
import { Alerts, Sections } from "./Sections";

/**
 * Home at a locker: what someone came to do, and nothing else. Taking gear out
 * or bringing it back is the usual next move, search is the fallback for gear
 * with no sticker (FR-OUT-02, FR-OUT-07), and a new item is the labelling walk.
 * Everything else lives behind the menu.
 */
export function Home({ store }: { store: Store }) {
  useStore(store);
  const route = useRoute();
  const query = route.query.get("q") ?? "";
  const [open, setOpen] = useState(false);

  // Replace, not push: typing a search must not fill the back button with keystrokes.
  const show = (text: string) => navigate(withQuery("/", filterParams(text, {})), true);

  const list = query ? rows(store.state, { query }) : [];

  return (
    <>
      <header>
        <h1>Gear Tracker</h1>
        <button
          className="corner"
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Close menu" : "Menu"}
        >
          {open ? "✕" : "☰"}
        </button>
      </header>
      <main>
        {open ? (
          <Sections store={store} layout="menu" />
        ) : (
          <>
            {/* First, so the keyboard pushing everything up never carries it off screen. */}
            <label className="tight search">
              <span>Search</span>
              <input type="search" value={query} onChange={(e) => show(e.target.value)} autoComplete="off" />
            </label>
            <Alerts store={store} />
            {query ? (
              list.length === 0 ? (
                <p>Nothing matches.</p>
              ) : (
                <ItemList store={store} list={list} />
              )
            ) : (
              <p className="muted">
                Take out or bring back gear by scanning its code. Search by name for gear with no sticker.
              </p>
            )}
          </>
        )}
      </main>
      {!open && (
        <div className="actions">
          <div className="row">
            <button className="primary tall" type="button" onClick={() => navigate("/scan?mode=out")}>
              Take out
            </button>
            <button className="tall" type="button" onClick={() => navigate("/scan?mode=in")}>
              Bring back
            </button>
          </div>
          <button type="button" onClick={() => navigate("/items/new")}>
            New item
          </button>
        </div>
      )}
    </>
  );
}
