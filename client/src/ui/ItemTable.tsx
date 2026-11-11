import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  byCategory,
  categories,
  categoryNames,
  displayName,
  type Filter,
  homeLabel,
  isNarrowing,
  type Item,
  type Row,
  rows,
} from "../lib/inventory";
import { filterParams, readFilter, withQuery } from "../lib/listUrl";
import { openRepairs } from "../lib/repairs";
import { entryState, hrefOf, navigate, restoringScroll, setEntryState, useRoute } from "../lib/router";
import { NATIVE } from "../lib/server";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { FilterFields } from "./Filters";
import { countsLabel, leftNote, plural, statusLabel } from "./labels";
import { Page } from "./Page";

type Key = "name" | "category" | "home" | "status" | "flags";

interface Sort {
  key: Key;
  /** Ascending until the same header is clicked again. */
  up: boolean;
}

const COLUMNS: { key: Key; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "home", label: "Home" },
  { key: "status", label: "Status" },
  { key: "category", label: "Category" },
  { key: "flags", label: "Flags" },
];

/** Name ascending is the default, so it is the one arrangement the URL leaves out. */
function readSort(query: URLSearchParams): Sort {
  const key = COLUMNS.find((c) => c.key === query.get("sort"))?.key ?? "name";
  return { key, up: query.get("dir") !== "down" };
}

function tableParams(text: string, filter: Filter, sort: Sort, grouped: boolean): URLSearchParams {
  const params = filterParams(text, filter);
  if (grouped) params.set("group", "category");
  if (sort.key !== "name") params.set("sort", sort.key);
  if (!sort.up) params.set("dir", "down");
  return params;
}

/** A generic has no status of its own; its units carry it. A generic and a pool show their in and out counts. */
const statusOf = (store: Store, row: Row): string => {
  if (row.kind === "single") return withLeft(store, row.item);
  return countsLabel(row);
};

const withLeft = (store: Store, it: Item): string =>
  [statusLabel(store.state, it), leftNote(store.state, it)].filter(Boolean).join(" · ");

function flagsOf(store: Store, it: Item): string[] {
  return [...(openRepairs(store.state, it.id).length > 0 ? ["Repair"] : []), ...(it.missing ? ["Missing"] : [])];
}

/** A generic shows its units' flags, so a shut one still says what needs a look. */
function rowFlags(store: Store, row: Row): string[] {
  if (row.kind === "single") return flagsOf(store, row.item);
  if (row.kind === "pool") return row.pool.missing > 0 ? ["Missing"] : [];
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

export function ItemLink({ id, children, native = NATIVE }: { id: string; children: ReactNode; native?: boolean }) {
  if (native) {
    return (
      <button className="link" type="button" onClick={() => navigate(`/items/${id}`)}>
        {children}
      </button>
    );
  }
  return (
    <a
      className="link"
      href={hrefOf(`/items/${id}`)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(`/items/${id}`);
      }}
    >
      {children}
    </a>
  );
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
  // Grouped by category (FR-INV-74), the headings say it, so the column goes.
  const grouped = hasCategories && route.query.get("group") === "category";
  const sort = readSort(route.query);
  const columns = COLUMNS.filter((c) => c.key !== "category" || (hasCategories && !grouped));
  const showCategory = columns.some((c) => c.key === "category");
  // No Category column to sort by while it is hidden; the URL keeps the choice for when it comes back.
  const effective: Sort = !showCategory && sort.key === "category" ? { key: "name", up: true } : sort;
  const [, refold] = useState(0);
  // A search or filter is looking for units, so it opens every generic it shows. Retired swaps the list; it does not narrow it.
  const narrowed = Boolean(query) || isNarrowing(filter);
  // Generics opened or shut by hand, by id: one set while browsing, another while narrowed.
  const looking = narrowed ? "narrowed" : "all";
  const folds = (key: string) =>
    ((entryState(key) as Record<string, Record<string, boolean>> | undefined) ?? {})[looking] ?? {};
  // Option-click sets every fold of its kind (FR-INV-75).
  const setFolds = (key: string, ids: string[], value: boolean) => {
    const all = (entryState(key) ?? {}) as Record<string, Record<string, boolean>>;
    setEntryState(key, { ...all, [looking]: { ...all[looking], ...Object.fromEntries(ids.map((id) => [id, value])) } });
    refold((n) => n + 1);
  };
  const unitFolds = folds("folds");
  // By category id ("" for none); categories start open.
  const categoryFolds = folds("categoryFolds");
  const toggle = (id: string, open: boolean, all: boolean) =>
    setFolds(
      "folds",
      all ? list.filter((r) => r.kind === "generic" && r.units.length > 0).map((r) => r.item.id) : [id],
      !open,
    );

  // Replace, not push: typing a search must not fill the back button with keystrokes.
  const show = (text: string, next: Filter, order: Sort, by = grouped) =>
    navigate(withQuery("/items", tableParams(text, next, order, by)), true);

  const list = [...rows(state, { ...filter, query })].sort((a, b) => {
    const cmp = sortKey(store, a, effective.key).localeCompare(sortKey(store, b, effective.key), undefined, {
      numeric: effective.key === "status",
    });
    return (effective.up ? cmp : -cmp) || a.name.localeCompare(b.name);
  });
  const sections = grouped
    ? byCategory(state, list).map((g) => ({
        id: g.category?.id ?? "",
        name: g.category?.name ?? "No category",
        rows: g.rows,
        open: categoryFolds[g.category?.id ?? ""] ?? true,
      }))
    : [{ id: "", name: null, rows: list, open: true }];
  const toggleCategory = (id: string, open: boolean, all: boolean) =>
    setFolds("categoryFolds", all ? sections.map((g) => g.id) : [id], !open);

  function sortBy(key: Key) {
    show(query, filter, { key, up: effective.key === key ? !effective.up : true });
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
        {hasCategories && (
          <label className="check">
            <input type="checkbox" checked={grouped} onChange={(e) => show(query, filter, sort, e.target.checked)} />
            <span>Group by category</span>
          </label>
        )}
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
                aria-sort={effective.key === c.key ? (effective.up ? "ascending" : "descending") : "none"}
              >
                <button className="link" type="button" onClick={() => sortBy(c.key)}>
                  {c.label}
                  {effective.key === c.key && (effective.up ? " ▲" : " ▼")}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        {sections.map((g) => (
          <tbody key={g.id}>
            {g.name !== null && (
              <tr>
                <th scope="rowgroup" colSpan={columns.length}>
                  <div className="name">
                    <FoldButton
                      open={g.open}
                      label={`Category ${g.name}`}
                      onToggle={(all) => toggleCategory(g.id, g.open, all)}
                    />
                    {g.name}
                  </div>
                </th>
              </tr>
            )}
            {g.open &&
              g.rows.map((row) => (
                <ItemRows
                  key={row.item.id}
                  store={store}
                  row={row}
                  showCategory={showCategory}
                  open={unitFolds[row.item.id] ?? narrowed}
                  onToggle={toggle}
                />
              ))}
          </tbody>
        ))}
      </table>
      {list.length === 0 && <p>Nothing matches.</p>}
    </Page>
  );
}

interface RowProps {
  store: Store;
  row: Row;
  /** The Category column is shown, and so is this cell (FR-SET-07, FR-INV-74). */
  showCategory: boolean;
  /** A generic's units are shown (FR-INV-25). */
  open: boolean;
  onToggle: (id: string, open: boolean, all: boolean) => void;
}

const ALL_HINT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "Option-click for all" : "Alt-click for all";

function FoldButton({ open, label, onToggle }: { open: boolean; label: string; onToggle: (all: boolean) => void }) {
  return (
    <button
      className="unit-fold muted small"
      type="button"
      aria-expanded={open}
      aria-label={label}
      title={ALL_HINT}
      onClick={(e) => onToggle(e.altKey)}
    >
      <span aria-hidden="true">{open ? "▾" : "▸"}</span>
    </button>
  );
}

/** One row, and a generic's units under it when open (FR-INV-25, FR-INV-75). */
function ItemRows({ store, row, showCategory, open, onToggle }: RowProps) {
  const state = store.state;
  const flags = rowFlags(store, row);
  return (
    <>
      <tr>
        <td>
          <div className="name">
            {row.kind === "generic" && row.units.length > 0 && (
              <FoldButton
                open={open}
                label={`Units of ${row.name}`}
                onToggle={(all) => onToggle(row.item.id, open, all)}
              />
            )}
            <ItemLink id={row.item.id}>{row.name}</ItemLink>
          </div>
        </td>
        <td>{homeLabel(state, row.item)}</td>
        <td>{statusOf(store, row)}</td>
        {showCategory && <td>{categoryNames(state, row.item)}</td>}
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
              <ItemLink id={unit.id}>{displayName(state, unit)}</ItemLink>
            </td>
            <td>{homeLabel(state, unit)}</td>
            <td>{withLeft(store, unit)}</td>
            {showCategory && <td>{categoryNames(state, unit)}</td>}
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
