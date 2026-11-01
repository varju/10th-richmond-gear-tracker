import { useEffect, useRef, useState } from "react";
import {
  categories,
  categoryNames,
  displayName,
  type Filter,
  homeLabel,
  type Item,
  type Row,
  rows,
} from "../lib/inventory";
import { filterParams, readFilter, withQuery } from "../lib/listUrl";
import { openRepairs } from "../lib/repairs";
import { entryState, navigate, restoringScroll, setEntryState, useRoute } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { FilterFields } from "./Filters";
import { plural, statusLabel } from "./labels";
import { Page } from "./Page";

type Key = "name" | "category" | "home" | "status" | "flags";

interface Sort {
  key: Key;
  /** Ascending until the same header is clicked again. */
  up: boolean;
}

const COLUMNS: { key: Key; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "category", label: "Category" },
  { key: "home", label: "Home" },
  { key: "status", label: "Status" },
  { key: "flags", label: "Flags" },
];

/** Name ascending is the default, so it is the one arrangement the URL leaves out. */
function readSort(query: URLSearchParams): Sort {
  const key = COLUMNS.find((c) => c.key === query.get("sort"));
  return { key: key?.key ?? "name", up: query.get("dir") !== "down" };
}

function tableParams(text: string, filter: Filter, sort: Sort): URLSearchParams {
  const params = filterParams(text, filter);
  if (sort.key !== "name") params.set("sort", sort.key);
  if (!sort.up) params.set("dir", "down");
  return params;
}

/** A generic has no status of its own; its units carry it. */
const statusOf = (store: Store, row: Row): string => (row.kind === "single" ? statusLabel(store.state, row.item) : "");

function flagsOf(store: Store, it: Item): string[] {
  return [...(openRepairs(store.state, it.id).length > 0 ? ["Repair"] : []), ...(it.missing ? ["Missing"] : [])];
}

/** A generic shows its units' flags, so a shut one still says what needs a look. */
function rowFlags(store: Store, row: Row): string[] {
  if (row.kind === "single") return flagsOf(store, row.item);
  if (row.kind === "pool") return [];
  const all = row.units.flatMap((u) => flagsOf(store, u));
  return ["Repair", "Missing"].filter((f) => all.includes(f));
}

function sortKey(store: Store, row: Row, key: Key): string {
  switch (key) {
    case "name":
      return row.name;
    case "category":
      return categoryNames(store.state, row.item);
    case "home":
      return homeLabel(store.state, row.item);
    case "status":
      return statusOf(store, row);
    case "flags":
      return rowFlags(store, row).join(" ");
  }
}

/**
 * The inventory at a desk: one row per item, sortable, with search
 * and the filters always in view (FR-INV-25, NFR-USE-10). The phone shows the
 * same data as a list; this is it laid out for a table and a mouse.
 */
export function ItemTable({ store }: { store: Store }) {
  useStore(store);
  const route = useRoute();
  const query = route.query.get("q") ?? "";
  const filter = readFilter(route.query);
  const sort = readSort(route.query);
  const camera = useCamera();
  const search = useRef<HTMLInputElement>(null);
  // Not on a return down the page: Safari scrolls a focused box into view, even with preventScroll.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!restoringScroll() && window.scrollY === 0) search.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const state = store.state;
  // A column only once the group has made a category (FR-SET-07).
  const hasCategories = categories(state).length > 0;
  const columns = COLUMNS.filter((c) => c.key !== "category" || hasCategories);
  const [, refold] = useState(0);
  // A search or filter is looking for units, so it opens every generic it shows. Retired swaps the list; it does not narrow it.
  const narrowed = Boolean(query || filter.location_id || filter.sub_location || filter.status || filter.category_id);
  // Generics opened or shut by hand, by id: one set while browsing, another while narrowed.
  const looking = narrowed ? "narrowed" : "all";
  const allFolds = (entryState("folds") ?? {}) as Record<string, Record<string, boolean>>;
  const folds = allFolds[looking] ?? {};
  const toggle = (id: string, open: boolean) => {
    setEntryState("folds", { ...allFolds, [looking]: { ...folds, [id]: !open } });
    refold((n) => n + 1);
  };

  // Replace, not push: typing a search must not fill the back button with keystrokes.
  const show = (text: string, next: Filter, order: Sort) =>
    navigate(withQuery("/items", tableParams(text, next, order)), true);

  const list = [...rows(state, { ...filter, query })].sort((a, b) => {
    const order = sortKey(store, a, sort.key).localeCompare(sortKey(store, b, sort.key));
    return (sort.up ? order : -order) || a.name.localeCompare(b.name);
  });

  function sortBy(key: Key) {
    show(query, filter, { key, up: sort.key === key ? !sort.up : true });
  }

  return (
    <Page title="Inventory" back="/">
      <div className="table-top">
        <label className="tight">
          <span>Search</span>
          {/* A desk starts typing; a phone would raise its keyboard over the list, so this screen is wide only. */}
          <input
            type="search"
            value={query}
            onChange={(e) => show(e.target.value, filter, sort)}
            autoComplete="off"
            ref={search}
          />
        </label>
        <FilterFields store={store} filter={filter} onChange={(f) => show(query, f, sort)} />
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
      <table className="grid inventory">
        <thead>
          <tr>
            {columns.map((c) => (
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
              showCategory={hasCategories}
              open={folds[row.item.id] ?? narrowed}
              onToggle={toggle}
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
  /** The Category column is shown, and so is this cell (FR-SET-07). */
  showCategory: boolean;
  /** A generic's units are shown (FR-INV-25). */
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
}

/** One row, and a generic's units under it when open (FR-INV-25). */
function ItemRows({ store, row, showCategory, open, onToggle }: RowProps) {
  const state = store.state;
  const flags = rowFlags(store, row);
  const counts = row.kind === "generic" ? `${plural(row.counts.total, "unit")} · ${row.counts.in} in` : "";
  return (
    <>
      <tr>
        <td>
          <div className="name">
            <button className="link" type="button" onClick={() => navigate(`/items/${row.item.id}`)}>
              {row.name}
            </button>
            {row.kind === "generic" && row.units.length === 0 && <span className="muted small">{counts}</span>}
            {row.kind === "generic" && row.units.length > 0 && (
              <button
                className="unit-fold muted small"
                type="button"
                aria-expanded={open}
                aria-label={`${counts}, ${row.name}`}
                onClick={() => onToggle(row.item.id, open)}
              >
                {counts} <span aria-hidden="true">{open ? "▾" : "▸"}</span>
              </button>
            )}
            {row.kind === "pool" && (
              <span className="muted small">{`${row.pool.in} in · ${row.pool.owned - row.pool.in} out`}</span>
            )}
          </div>
        </td>
        {showCategory && <td>{categoryNames(state, row.item)}</td>}
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
            {showCategory && <td>{categoryNames(state, unit)}</td>}
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
