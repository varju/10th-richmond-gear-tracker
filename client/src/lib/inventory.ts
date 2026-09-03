/**
 * Reading the state: what an item, a location, a code look like, and the
 * questions the screens ask of them. Pure functions over Store.state.
 *
 * One entity kind carries three shapes (FR-INV-21). A single item has a name.
 * A generic has a name and `generic`, no code and no movements. A unit has a
 * parent and a number, and no name of its own: its name is derived, so read it
 * with displayName and never with `it.name`.
 */
import type { Fields, Movement, Note, PoolEvents, PoolOut, State } from "./replay";

export interface Item {
  id: string;
  /** Absent on a unit; its name comes from its generic (FR-INV-22). */
  name?: string | null;
  description?: string;
  home_location_id?: string | null;
  sub_location?: string;
  /** One thing the group owns several of. Takes no code and no movement (FR-INV-21). */
  generic?: boolean;
  /**
   * A counted stack, not units (FR-INV-34): always a generic, with no code and no units of its own.
   * `pool_in` and `pool_out` carry the truth; `quantity` is what `created` was given and is not kept
   * current. Read both through `poolCounts`.
   */
  pool?: boolean;
  quantity?: number;
  /** What is on the shelf right now. Set only on a pool (FR-INV-34). */
  pool_in?: number;
  /** Holder id to count, for what is checked out of a pool. Holders at zero are absent (FR-INV-34). */
  pool_out?: PoolOut;
  /** Event name to count checked out under it, never reduced by a return. Set only on a pool (FR-RES-13). */
  pool_events?: PoolEvents;
  /** Set on a unit: the generic it belongs to. */
  parent_id?: string | null;
  /** Set on a single item or a generic; a unit reads its generic's (FR-SET-07). */
  category_ids?: string[];
  /** Pre-2026-09 single category. Still read on old items and old events; never written again (FR-SET-07). */
  category_id?: string | null;
  /**
   * A unit's number under its parent, unique there. Text: the gear may read
   * "A" or "3b" (FR-INV-23). Events written before that hold a whole number,
   * so read it through `numberOf`, never as a string.
   */
  number?: string | number | null;
  /** "patched fly": what tells this unit from its siblings (FR-INV-23). */

  nickname?: string | null;
  /** "YYYY-MM-DD" (FR-INV-12). */
  purchase_date?: string | null;
  /** Dollars, to the cent. */
  price?: number | null;
  retired?: boolean;
  /** Lost, not written off (FR-INV-19). Cleared by the next scan or check-in. */
  missing?: boolean;
  /** Set on a duplicate: the item it was folded into (FR-INV-13). Everything that reads an id follows it. */
  merged_into?: string | null;
  /**
   * A record made in error, taken off every list by an Admin (FR-INV-32). A
   * tombstone, like a location's: the row stays so old references can name it,
   * and there is no way back in the app. Retire (FR-INV-04) is the one for gear
   * written off.
   */
  deleted?: boolean;
  /** Absent on a generic: it does not move. */
  status?: "in" | "out";
  holder_id?: string | null;
  since?: number;
  movement?: Movement;
  notes?: Note[];
  conflicts?: unknown[];
  /** The later check-out of a conflict the Quartermaster has reviewed (FR-OFF-10). */
  reviewed_movement?: string | null;
  added_at?: number;
  modified_at?: number;
}

export interface Location {
  id: string;
  name: string;
  deleted?: boolean;
}

export interface Category {
  id: string;
  name: string;
  deleted?: boolean;
}

export interface Code {
  id: string;
  /** Absent: never bound. Null: bound once, then released (FR-TAG-14). Either way, the code is unassigned. */
  item_id?: string | null;
  bound_at?: number;
}

export interface GroupSetting {
  name?: string;
  /** The address the app lives at; stickers carry it plus /g/<code>. The key predates the meaning. */
  code_url?: string;
  /** How a finder reaches us. Shown on the public page (FR-PUB-01). */
  contact?: string;
  /** Out longer than this is flagged (FR-OUT-14). Unset means never. */
  overdue_days?: number | null;
}

/** Codes are 10 characters of Crockford base32, upper case. Matches codes.py on the server. */
export const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;

function withId<T>(table: Record<string, Fields> | undefined): T[] {
  return Object.entries(table ?? {}).map(([id, fields]) => ({ id, ...fields }) as T);
}

/** Every item worth listing. A deleted one is gone from here, as a deleted location is (FR-INV-32). */
export const items = (state: State): Item[] => withId<Item>(state.item).filter((it) => !it.deleted);
export const locations = (state: State): Location[] => withId<Location>(state.location).filter((l) => !l.deleted);
/** Sorted by name, unlike locations(): every screen that lists categories wants that order. */
export const categories = (state: State): Category[] =>
  withId<Category>(state.category)
    .filter((c) => !c.deleted)
    .sort((a, b) => a.name.localeCompare(b.name));
export const codes = (state: State): Code[] => withId<Code>(state.code);
export const group = (state: State): GroupSetting => (state.setting?.group ?? {}) as GroupSetting;

/** One item by id, deleted ones included: its own page and an old reference still name it (FR-INV-32). */
export const item = (state: State, id: string): Item | undefined =>
  state.item?.[id] ? ({ id, ...state.item[id] } as Item) : undefined;

const MERGE_HOPS = 10;

/** The item that stands for this id today: itself, or the survivor of a merge (FR-INV-13). */
export function resolveItem(state: State, id: string): string {
  let current = id;
  for (let hop = 0; hop < MERGE_HOPS; hop++) {
    const next = state.item?.[current]?.merged_into as string | null | undefined;
    if (!next || !state.item?.[next]) return current;
    current = next;
  }
  return current;
}

/** This id and every item merged into it, however many steps down. The first entry is the id itself. */
export function aliases(state: State, id: string): string[] {
  const found = [id];
  for (let i = 0; i < found.length && found.length <= MERGE_HOPS * 10; i++) {
    for (const [other, fields] of Object.entries(state.item ?? {})) {
      if (fields.merged_into === found[i] && !found.includes(other)) found.push(other);
    }
  }
  return found;
}
export const code = (state: State, id: string): Code | undefined =>
  state.code?.[id] ? ({ id, ...state.code[id] } as Code) : undefined;
export const locationName = (state: State, id: string | null | undefined): string =>
  id ? (state.location?.[id]?.name as string | undefined) ?? "(unknown location)" : "";
export const categoryName = (state: State, id: string | null | undefined): string =>
  id ? (state.category?.[id]?.name as string | undefined) ?? "(unknown category)" : "";

// --- generics and units -------------------------------------------------------------------

export const isGeneric = (it: Item): boolean => Boolean(it.generic);
export const isUnit = (it: Item): boolean => Boolean(it.parent_id);
export const isPool = (it: Item): boolean => Boolean(it.pool);

export interface PoolHolderCount {
  holder_id: string;
  count: number;
}

export interface PoolCounts {
  owned: number;
  in: number;
  out: PoolHolderCount[];
}

/** Owned, in, and out by holder for a pool (FR-INV-36). `owned` is `in` plus every holder's count. */
export function poolCounts(it: Item): PoolCounts {
  const poolIn = it.pool_in ?? 0;
  const out = Object.entries(it.pool_out ?? {})
    .filter(([, count]) => count > 0)
    .map(([holder_id, count]) => ({ holder_id, count }));
  return { owned: poolIn + out.reduce((sum, o) => sum + o.count, 0), in: poolIn, out };
}

/** Things that move: single items and units, never a generic. */
export const movable = (state: State): Item[] => items(state).filter((it) => !it.generic);

export const generics = (state: State): Item[] => items(state).filter((it) => it.generic);

/**
 * A unit's number as text. Events written before numbers were text hold a
 * whole number, so coerce rather than assume. Mirrors views.py.
 */
export const numberOf = (it: Item): string => String(it.number ?? "").trim();

/**
 * Unit numbers in the order people read them: whole numbers first and in
 * numeric order, so 2 comes before 10, then everything else as text. Mirrored
 * in views.py, which sorts the same lists for the assistant.
 */
export function byNumber(a: Item, b: Item): number {
  const x = numberOf(a);
  const y = numberOf(b);
  const nx = /^\d+$/.test(x) ? Number(x) : null;
  const ny = /^\d+$/.test(y) ? Number(y) : null;
  if (nx !== null && ny !== null) return nx - ny;
  if (nx !== null) return -1;
  if (ny !== null) return 1;
  return x.localeCompare(y);
}

/** The units under a generic, in number order. Retired ones included; callers filter. Empty for a pool (FR-INV-34): a device may not create a unit under one (server rule). */
export const unitsOf = (state: State, genericId: string): Item[] =>
  items(state)
    .filter((it) => it.parent_id === genericId && !it.merged_into)
    .sort(byNumber);

/** The generic a unit belongs to, if this device has it. */
export const parentOf = (state: State, it: Item): Item | undefined =>
  it.parent_id ? item(state, it.parent_id) : undefined;

/**
 * An item's own category ids, before a unit reads its generic's and before
 * dropping ids of categories that no longer exist. `category_ids` wins when
 * present, even `[]`; otherwise `category_id` if it is set (FR-SET-07).
 */
function rawCategoryIds(it: Item): string[] {
  if (it.category_ids !== undefined) return it.category_ids;
  if (it.category_id) return [it.category_id];
  return [];
}

/** A unit's categories are its generic's; anything else carries its own (FR-SET-07). Drops unknown or deleted ids. */
export function categoriesOf(state: State, it: Item): string[] {
  const source = isUnit(it) ? parentOf(state, it) : it;
  const ids = source ? rawCategoryIds(source) : [];
  const live = new Set(categories(state).map((c) => c.id));
  return ids.filter((id) => live.has(id));
}

/** The names of categoriesOf, joined for one cell or line. Empty string when there are none. */
export const categoryNames = (state: State, it: Item): string =>
  categoriesOf(state, it)
    .map((id) => categoryName(state, id))
    .join(", ");

/**
 * The name a person reads: "4-person tent, Brand X #3 (patched fly)" for a
 * unit, the item's own name otherwise (FR-INV-22).
 */
export function displayName(state: State, it: Item): string {
  if (!it.parent_id) return it.name ?? "";
  const parent = parentOf(state, it);
  const base = `${parent?.name ?? "(unknown item)"} #${numberOf(it) || "?"}`;
  return it.nickname ? `${base} (${it.nickname})` : base;
}

/** The same, from an id. For lists that hold ids rather than items. */
export const nameOf = (state: State, id: string | null | undefined): string => {
  const it = id ? item(state, id) : undefined;
  return it ? displayName(state, it) : "(unknown item)";
};

/** Sort by the name on screen. */
export const byName = (state: State) => (a: Item, b: Item) =>
  displayName(state, a).localeCompare(displayName(state, b));

/**
 * What to offer on a new unit, editable before it is saved (FR-INV-23): one
 * after the largest whole number in use, or "1" under an empty generic.
 * Numbers that are not whole numbers are ignored here; the person types those.
 */
export function nextNumber(state: State, genericId: string): string {
  const used = unitsOf(state, genericId)
    .map(numberOf)
    .filter((n) => /^\d+$/.test(n))
    .map(Number);
  return String(used.length ? Math.max(...used) + 1 : 1);
}

/** Numbers are unique within a generic, checked on this device (FR-INV-23). Case counts. */
export const numberTaken = (state: State, genericId: string, number: string, exceptId?: string): boolean =>
  unitsOf(state, genericId).some((u) => numberOf(u) === number.trim() && u.id !== exceptId);

/**
 * Generics worth offering on a scanned code, most recently touched first
 * (FR-INV-24). Touched means the generic itself or any of its units, so the
 * one being labelled stays at the top of the walk. A pool takes no code, so
 * it is never offered here (FR-INV-34).
 */
export function recentGenerics(state: State, limit = 4): Item[] {
  const touched = (g: Item): number =>
    Math.max(g.modified_at ?? 0, ...unitsOf(state, g.id).map((u) => Math.max(u.added_at ?? 0, u.modified_at ?? 0)), 0);
  return generics(state)
    .filter((g) => !g.retired && !g.merged_into && !isPool(g))
    .sort((a, b) => touched(b) - touched(a) || displayName(state, a).localeCompare(displayName(state, b)))
    .slice(0, limit);
}

// --- codes --------------------------------------------------------------------------------

export type CodeStatus = "unassigned" | "assigned" | "replaced" | "unknown";

/** Every code that has ever been on the item, newest binding first. The first is its current code.
 * A code on a merged duplicate counts as the survivor's, so the old sticker still finds the item. */
export function codesFor(state: State, itemId: string): Code[] {
  return codes(state)
    .filter((c) => c.item_id != null && resolveItem(state, c.item_id) === itemId)
    .sort((a, b) => (b.bound_at ?? 0) - (a.bound_at ?? 0) || (a.id < b.id ? 1 : -1));
}

export const currentCode = (state: State, itemId: string): Code | undefined => codesFor(state, itemId)[0];

/** What a scan of this code means (architecture.md, "Code lifecycle"). */
export function codeStatus(state: State, id: string): CodeStatus {
  const c = code(state, id);
  if (!c) return "unknown";
  if (!c.item_id) return "unassigned";
  return currentCode(state, resolveItem(state, c.item_id))?.id === id ? "assigned" : "replaced";
}

/** Home as people say it: "Warm locker / shelf 4" (FR-INV-02). */
export function homeLabel(state: State, it: Item): string {
  const loc = locationName(state, it.home_location_id);
  return it.sub_location ? (loc ? `${loc} / ${it.sub_location}` : it.sub_location) : loc;
}

export interface Filter {
  query?: string;
  location_id?: string;
  sub_location?: string;
  status?: "in" | "out" | "missing";
  retired?: boolean;
  category_id?: string;
}

const terms = (query: string | undefined): string[] => (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Every word must appear in the name, or a unit's number and nickname (FR-INV-07).
 * Not the home: "Home" or a locker's name would pull in everything that lives there.
 */
function matches(state: State, it: Item, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = displayName(state, it).toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * Search as you type (FR-INV-07), over the things that move: single items and
 * units. Generics are not here; the list groups units under them in rows().
 * Merged duplicates are never listed; their survivor is.
 */
export function search(state: State, filter: Filter): Item[] {
  const words = terms(filter.query);
  return movable(state)
    .filter((it) => !it.merged_into)
    .filter((it) => Boolean(it.retired) === Boolean(filter.retired))
    .filter((it) => !filter.location_id || it.home_location_id === filter.location_id)
    .filter((it) => !filter.sub_location || it.sub_location === filter.sub_location)
    .filter((it) => !filter.status || (filter.status === "missing" ? Boolean(it.missing) : it.status === filter.status))
    .filter((it) => !filter.category_id || categoriesOf(state, it).includes(filter.category_id))
    .filter((it) => matches(state, it, words))
    .sort(byName(state));
}

export interface SingleRow {
  kind: "single";
  item: Item;
  name: string;
}

export interface GenericRow {
  kind: "generic";
  item: Item;
  name: string;
  /** The units that matched, in number order. */
  units: Item[];
  counts: { total: number; in: number };
}

export interface PoolRow {
  kind: "pool";
  item: Item;
  name: string;
  /** Owned, in, and out by holder (FR-INV-36). */
  pool: PoolCounts;
}

export type Row = SingleRow | GenericRow | PoolRow;

/**
 * The list: one row per generic with its counts, single items as rows of their
 * own (FR-INV-25). Filters apply to units, and a generic is here when any of
 * its units matched. A generic with nothing under it is still a row when only
 * the search text is set, so an empty one can be found and given units. A
 * pool is its own row kind, with its counts instead of units (FR-INV-36): it
 * has none to hold, and is found the same way an empty generic is.
 */
/**
 * A pool has no units for search() to filter, so it is matched here: on its
 * home and shelf, its categories, and its counts. "in" means stock on the
 * shelf, "out" means anything checked out to a holder. "missing" never
 * matches; a pool has no such state. Twin of pool_wanted in views.py.
 */
function poolWanted(state: State, pool: Item, filter: Filter): boolean {
  if (filter.location_id && pool.home_location_id !== filter.location_id) return false;
  if (filter.sub_location && pool.sub_location !== filter.sub_location) return false;
  if (filter.category_id && !categoriesOf(state, pool).includes(filter.category_id)) return false;
  const counts = poolCounts(pool);
  if (filter.status === "in") return counts.in > 0;
  if (filter.status === "out") return counts.out.length > 0;
  return filter.status !== "missing";
}

export function rows(state: State, filter: Filter): Row[] {
  const singles: Row[] = [];
  const pools: Row[] = [];
  const byParent = new Map<string, Item[]>();
  for (const it of search(state, filter)) {
    const parent = it.parent_id && state.item?.[it.parent_id] ? it.parent_id : "";
    if (parent) byParent.set(parent, [...(byParent.get(parent) ?? []), it]);
    else singles.push({ kind: "single", item: it, name: displayName(state, it) });
  }
  const words = terms(filter.query);
  const unfiltered = !filter.location_id && !filter.sub_location && !filter.status && !filter.category_id;
  for (const g of generics(state)) {
    if (g.merged_into || Boolean(g.retired) !== Boolean(filter.retired)) continue;
    if (!matches(state, g, words)) continue;
    if (isPool(g)) {
      if (poolWanted(state, g, filter))
        pools.push({ kind: "pool", item: g, name: displayName(state, g), pool: poolCounts(g) });
    } else if (unfiltered && !byParent.has(g.id)) {
      byParent.set(g.id, []);
    }
  }
  const grouped: Row[] = [...byParent.entries()].map(([id, units]) => {
    const parent = item(state, id) ?? ({ id } as Item);
    return {
      kind: "generic",
      item: parent,
      name: displayName(state, parent),
      units: units.sort(byNumber),

      counts: { total: units.length, in: units.filter((u) => u.status === "in" && !u.missing).length },
    };
  });
  return [...grouped, ...singles, ...pools].sort((a, b) => a.name.localeCompare(b.name));
}

/** How many things the rows stand for: units and single items, and a pool's owned quantity, not a generic itself. */
export const countItems = (list: Row[]): number =>
  list.reduce((n, r) => n + (r.kind === "single" ? 1 : r.kind === "pool" ? r.pool.owned : r.units.length), 0);

/** The shelf labels in use, for a suggestion list. Labels, not entities (FR-SET-03). */
export function subLocations(state: State, locationId?: string): string[] {
  const seen = new Set<string>();
  for (const it of items(state)) {
    if (it.sub_location && (!locationId || it.home_location_id === locationId)) seen.add(it.sub_location);
  }
  // "shelf 2" before "shelf 10": the number in a label counts as a number.
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Items that stop a location being deleted (FR-SET-05). Retired items count: they can come back. */
export function blockers(state: State, locationId: string): Item[] {
  return items(state)
    .filter((it) => it.home_location_id === locationId)
    .sort(byName(state));
}

/**
 * Items that stop a category being deleted (FR-SET-05). Retired items count:
 * they can come back. Raw ids, not categoriesOf: a category already gone from
 * categories(state) must still be able to name what was pointing at it.
 */
export function categoryBlockers(state: State, categoryId: string): Item[] {
  return items(state)
    .filter((it) => rawCategoryIds(it).includes(categoryId))
    .sort(byName(state));
}

export interface CategoryGroup {
  category: Category | null;
  rows: Row[];
}

/**
 * Rows grouped by category, in categories(state) order, with the uncategorised
 * rows last under a null category (FR-SET-07, FR-INV-08). A row with several
 * categories appears in every one of them: that is the cross-listing the
 * Quartermaster asked for. A category deleted since a row was filed under it
 * is treated as no category. Empty groups are left out.
 */
export function byCategory(state: State, list: Row[]): CategoryGroup[] {
  const byId = new Map<string, Row[]>();
  const uncategorised: Row[] = [];
  for (const row of list) {
    const ids = categoriesOf(state, row.item);
    if (ids.length === 0) uncategorised.push(row);
    else for (const id of ids) byId.set(id, [...(byId.get(id) ?? []), row]);
  }
  const groups: CategoryGroup[] = categories(state)
    .map((category) => ({ category, rows: byId.get(category.id) ?? [] }))
    .filter((g) => g.rows.length > 0);
  if (uncategorised.length > 0) groups.push({ category: null, rows: uncategorised });
  return groups;
}
