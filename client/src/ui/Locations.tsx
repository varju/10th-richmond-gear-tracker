import { atLocation, bySubLocation, displayName, locationName, locations } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { plural, statusLabel } from "./labels";
import { Page } from "./Page";

/** Every location and how much lives there (FR-INV-10). */
export function Locations({ store }: { store: Store }) {
  useStore(store);
  const all = locations(store.state).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Page title="Locations" back="/">
      {all.length === 0 ? (
        <p>No locations yet. An Admin adds them in Settings.</p>
      ) : (
        <ul className="items">
          {all.map((l) => (
            <li key={l.id}>
              <button className="item" type="button" onClick={() => navigate(`/locations/${l.id}`)}>
                <span className="item-name">{l.name}</span>
                <span className="muted small">{plural(atLocation(store.state, l.id).length, "item")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

/** One location, shelf by shelf: "what belongs on shelf 4?" (FR-INV-10). */
export function LocationPage({ store, id }: { store: Store; id: string }) {
  useStore(store);
  const state = store.state;
  const shelves = bySubLocation(state, id);
  return (
    <Page title={locationName(state, id) || "Location"} back="/locations">
      {shelves.length === 0 ? (
        <p>Nothing lives here.</p>
      ) : (
        shelves.map((shelf) => (
          <section key={shelf.sub_location} aria-label={shelf.sub_location || "No sub-location"}>
            <h2 className="section">{shelf.sub_location || "No sub-location"}</h2>
            <ul className="items">
              {shelf.items.map((it) => (
                <li key={it.id}>
                  <button className="item" type="button" onClick={() => navigate(`/items/${it.id}`)}>
                    <span className="item-name">{displayName(store.state, it)}</span>
                    <span className="muted small">{statusLabel(state, it)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </Page>
  );
}
