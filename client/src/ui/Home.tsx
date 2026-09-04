import { rows } from "../lib/inventory";
import { filterParams, withQuery } from "../lib/listUrl";
import { dueToPack, todayIso } from "../lib/reservations";
import { navigate, useRoute } from "../lib/router";
import type { Store } from "../lib/store";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { ItemList } from "./ItemList";
import { Page } from "./Page";
import { datesLabel } from "./Reservations";
import { Alerts } from "./Sections";

/**
 * Home at a locker: what someone came to do, and nothing else. Taking gear out
 * or bringing it back is the usual next move, search is the fallback for gear
 * with no sticker (FR-OUT-02, FR-OUT-07), and a new item is the labelling walk.
 * Everything else lives behind the menu.
 */
export function Home({ store }: { store: Store }) {
  useStore(store);
  const route = useRoute();
  const { now } = useShell();
  const query = route.query.get("q") ?? "";

  // Replace, not push: typing a search must not fill the back button with keystrokes.
  const show = (text: string) => navigate(withQuery("/", filterParams(text, {})), true);

  const list = query ? rows(store.state, { query }) : [];
  const packing = dueToPack(store.state, todayIso(now()));

  return (
    <Page
      title="Gear Tracker"
      actions={
        <>
          <div className="row">
            <button className="primary tall" type="button" onClick={() => navigate("/scan?mode=out")}>
              Check out
            </button>
            <button className="tall" type="button" onClick={() => navigate("/scan?mode=in")}>
              Return
            </button>
          </div>
          {packing.length > 0 && (
            <section aria-label="Ready to pack">
              <ul className="items">
                {packing.map((r) => (
                  <li key={r.id}>
                    <button
                      className="item"
                      type="button"
                      onClick={() => navigate(`/scan?mode=out&reservation=${r.id}`)}
                    >
                      <span className="item-name">{r.event}</span>
                      <span className="muted small">{datesLabel(r)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <button type="button" onClick={() => navigate("/items/new")}>
            New item
          </button>
        </>
      }
    >
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
        <p className="muted">Check out or return gear by scanning its code. Search by name for gear with no sticker.</p>
      )}
    </Page>
  );
}
