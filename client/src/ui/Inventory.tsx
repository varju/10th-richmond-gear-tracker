import { useState } from "react";
import { openConflicts } from "../lib/conflicts";
import { foundReports } from "../lib/found";
import { type Filter, homeLabel, items, itemTypes, locations, search, subLocations } from "../lib/inventory";
import { openRepairs, openTickets } from "../lib/repairs";
import { todayIso, upcoming } from "../lib/reservations";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { plural, statusLabel, syncLabel } from "./labels";

interface Props {
  store: Store;
}

/** Home: the list, searched as you type, with the scanner one tap away (FR-INV-07). */
export function Inventory({ store }: Props) {
  useStore(store);
  const { now } = useShell();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({});
  const state = store.state;
  const results = search(state, { ...filter, query });
  const empty = items(state).length === 0;
  // Missing gear is not out (FR-INV-19); the report agrees.
  const out = items(state).filter((it) => it.status === "out" && !it.missing).length;
  const found = foundReports(state).length;
  const clashes = openConflicts(state).length;
  const broken = openTickets(state).length;
  const booked = upcoming(state, todayIso(now())).length;
  const admin = store.meta.user?.role === "admin";

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
          {plural(results.length, "item")}
          {store.meta.last_sync_at !== undefined && ` · ${syncLabel(store.meta.last_sync_at, Date.now(), false, null)}`}
        </p>
        {/* Things wrong, only when something is wrong. */}
        {found > 0 && (
          <button className="link" type="button" onClick={() => navigate("/found")}>
            Found gear · {found}
          </button>
        )}
        {clashes > 0 && (
          <button className="link" type="button" onClick={() => navigate("/conflicts")}>
            Conflicts · {clashes}
          </button>
        )}
        {/* Everywhere else the app goes. Always here, so nothing is only reachable by knowing it exists. */}
        <nav className="links" aria-label="Sections">
          <button className="link" type="button" onClick={() => navigate("/out")}>
            What is out{out > 0 && ` · ${out}`}
          </button>
          <button className="link" type="button" onClick={() => navigate("/repairs")}>
            Needs repair{broken > 0 && ` · ${broken}`}
          </button>
          <button className="link" type="button" onClick={() => navigate("/reservations")}>
            Reservations · {booked} upcoming
          </button>
          {!empty && (
            <>
              <button className="link" type="button" onClick={() => navigate("/locations")}>
                Browse by location
              </button>
              <button className="link" type="button" onClick={() => navigate("/stock-check")}>
                {store.meta.stock_check ? "Stock check · in progress" : "Stock check"}
              </button>
            </>
          )}
          {admin && (
            <button className="link" type="button" onClick={() => navigate("/settings/users")}>
              Users
            </button>
          )}
        </nav>
        {empty ? (
          <p>Nothing here yet. Scan a code or add a new item.</p>
        ) : (
          <>
            <Filters store={store} filter={filter} onChange={setFilter} />
            <ul className="items">
              {results.map((it) => (
                <li key={it.id}>
                  <button className="item" type="button" onClick={() => navigate(`/items/${it.id}`)}>
                    <span>
                      <span className="item-name">{it.name}</span>
                      {openRepairs(state, it.id).length > 0 && <span className="badge">Repair</span>}
                      {it.missing && <span className="badge">Missing</span>}
                    </span>
                    <span className="muted small">
                      {[homeLabel(state, it), it.status === "out" && !it.missing ? statusLabel(state, it) : ""]
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

function Filters({ store, filter, onChange }: { store: Store; filter: Filter; onChange: (f: Filter) => void }) {
  const state = store.state;
  const set = (patch: Partial<Filter>) => onChange({ ...filter, ...patch });
  const active = Object.values(filter).filter(Boolean).length;
  return (
    <details className="filters">
      <summary>Filters{active > 0 && ` (${active})`}</summary>
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
          <span>Type</span>
          <select value={filter.type_id ?? ""} onChange={(e) => set({ type_id: e.target.value || undefined })}>
            <option value="">Any</option>
            {itemTypes(state).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
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
    </details>
  );
}
