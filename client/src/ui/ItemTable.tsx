import { useEffect, useState } from "react";
import { displayName, type Filter, homeLabel, type Item, type Row, rows } from "../lib/inventory";
import { openRepairs } from "../lib/repairs";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { FilterFields } from "./Filters";
import { plural, statusLabel } from "./labels";
import { Page } from "./Page";

type Key = "name" | "home" | "status" | "flags";

interface Sort {
  key: Key;
  /** Ascending until the same header is clicked again. */
  up: boolean;
}

const COLUMNS: { key: Key; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "home", label: "Home" },
  { key: "status", label: "Status" },
  { key: "flags", label: "Flags" },
];

/** A generic has no status of its own; its units carry it. */
const statusOf = (store: Store, row: Row): string => (row.kind === "single" ? statusLabel(store.state, row.item) : "");

function flagsOf(store: Store, it: Item): string[] {
  return [...(openRepairs(store.state, it.id).length > 0 ? ["Repair"] : []), ...(it.missing ? ["Missing"] : [])];
}

function sortKey(store: Store, row: Row, key: Key): string {
  switch (key) {
    case "name":
      return row.name;
    case "home":
      return homeLabel(store.state, row.item);
    case "status":
      return statusOf(store, row);
    case "flags":
      return row.kind === "single" ? flagsOf(store, row.item).join(" ") : "";
  }
}

/**
 * The inventory at a desk: every row on screen at once, sortable, with search
 * and the filters always in view (FR-INV-25, NFR-USE-10). The phone keeps its
 * list; this is the same data laid out for a table and a mouse.
 */
export function ItemTable({ store }: { store: Store }) {
  useStore(store);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({});
  const [sort, setSort] = useState<Sort>({ key: "name", up: true });
  const [open, setOpen] = useState<string[]>([]);
  const camera = useCamera();
  const state = store.state;

  const list = [...rows(state, { ...filter, query })].sort((a, b) => {
    const order = sortKey(store, a, sort.key).localeCompare(sortKey(store, b, sort.key));
    return (sort.up ? order : -order) || a.name.localeCompare(b.name);
  });

  function sortBy(key: Key) {
    setSort((s) => ({ key, up: s.key === key ? !s.up : true }));
  }

  return (
    <Page title="Inventory" back="/">
      <div className="table-top">
        <label className="tight">
          <span>Search</span>
          {/* A desk starts typing; a phone would raise its keyboard over the list, so this screen is wide only. */}
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" autoFocus />
        </label>
        <FilterFields store={store} filter={filter} onChange={setFilter} />
        <div className="table-actions">
          <button className="primary" type="button" onClick={() => navigate("/items/new")}>
            New item
          </button>
          {camera && (
            <button type="button" onClick={() => navigate("/scan")}>
              Scan
            </button>
          )}
        </div>
      </div>
      <p className="muted small">{plural(list.length, "row")}</p>
      <table className="grid">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                scope="col"
                aria-sort={sort.key === c.key ? (sort.up ? "ascending" : "descending") : "none"}
              >
                <button className="link" type="button" onClick={() => sortBy(c.key)}>
                  {c.label}
                  {sort.key === c.key && (sort.up ? " ▲" : " ▼")}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((row) => (
            <ItemRows
              key={row.item.id}
              store={store}
              row={row}
              open={open.includes(row.item.id)}
              onToggle={() =>
                setOpen((ids) =>
                  ids.includes(row.item.id) ? ids.filter((x) => x !== row.item.id) : [...ids, row.item.id],
                )
              }
            />
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p>Nothing matches.</p>}
    </Page>
  );
}

interface RowProps {
  store: Store;
  row: Row;
  open: boolean;
  onToggle: () => void;
}

/** One row, and the units under it when a generic is opened (FR-INV-25). */
function ItemRows({ store, row, open, onToggle }: RowProps) {
  const state = store.state;
  const flags = row.kind === "single" ? flagsOf(store, row.item) : [];
  return (
    <>
      <tr>
        <td>
          {row.kind === "generic" && (
            <button
              className="disclose"
              type="button"
              aria-expanded={open}
              aria-label={`Units of ${row.name}`}
              onClick={onToggle}
            >
              {open ? "▾" : "▸"}
            </button>
          )}
          <button className="link" type="button" onClick={() => navigate(`/items/${row.item.id}`)}>
            {row.name}
          </button>
          {row.kind === "generic" && (
            <span className="muted small home">{`${plural(row.counts.total, "unit")} · ${row.counts.in} in`}</span>
          )}
        </td>
        <td>{homeLabel(state, row.item)}</td>
        <td>{statusOf(store, row)}</td>
        <td>
          {flags.map((f) => (
            <span key={f} className="badge">
              {f}
            </span>
          ))}
        </td>
      </tr>
      {row.kind === "generic" &&
        open &&
        row.units.map((unit) => (
          <tr key={unit.id} className="unit">
            <td>
              <button className="link" type="button" onClick={() => navigate(`/items/${unit.id}`)}>
                {displayName(state, unit)}
              </button>
            </td>
            <td>{homeLabel(state, unit)}</td>
            <td>{statusLabel(state, unit)}</td>
            <td>
              {flagsOf(store, unit).map((f) => (
                <span key={f} className="badge">
                  {f}
                </span>
              ))}
            </td>
          </tr>
        ))}
    </>
  );
}

/** No camera, no Scan button. A desk browser usually has neither. */
function useCamera(): boolean {
  const [camera, setCamera] = useState(false);
  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) return;
    void devices
      .enumerateDevices()
      .then((list) => setCamera(list.some((d) => d.kind === "videoinput")))
      .catch(() => setCamera(false));
  }, []);
  return camera;
}
