/**
 * Reading the state: what an item, a location, a code look like, and the
 * questions the screens ask of them. Pure functions over Store.state.
 *
 * One entity kind carries three shapes (FR-INV-21). A single item has a name.
 * A generic has a name and `generic`, no code and no movements. A unit has a
 * parent and a number, and no name of its own: its name is derived, so read it
 * with displayName and never with `it.name`.
 */
import { keepNewest } from "./replay";
import type { Store } from "./store";
import type { Reading, Weight } from "./weighing";
import type { Fields, Movement, Note, PoolLot, PoolLots, PoolOut, PoolReservations, State } from "./replay";

export interface Item {
  id: string;
  /** Absent on a unit; its name comes from its generic (FR-INV-22). */
  name?: string | null;
  description?: string;
  home_location_id?: string | null;
  /** A person as home, instead of a location (FR-INV-59). Never set together with home_location_id. */
  home_user_id?: string | null;
  sub_location?: string;
  /** One thing the group owns several of. Takes no code and no movement (FR-INV-21). */
  generic?: boolean;
  /**
   * A counted stack, not units (FR-INV-34): always a generic, with no units of its own. It may
   * still carry a code, on the container that holds the stack (FR-TAG-15). `pool_in` and
   * `pool_out` carry the truth; `quantity` is what `created` was given and is not kept current.
   * Read both through `poolCounts`.
   */
  pool?: boolean;
  quantity?: number;
  /** What is on the shelf right now. Set only on a pool (FR-INV-34). */
  pool_in?: number;
  /** Owned but lost, for a pool. Absent until the first one is marked missing (FR-INV-46). */
  pool_missing?: number;
  /** Holder id to count, for what is checked out of a pool. Holders at zero are absent (FR-INV-34). */
  pool_out?: PoolOut;
  /** Reservation id to count checked out for it, never reduced by a return. Set only on a pool (FR-RES-13). */
  pool_reservations?: PoolReservations;
  /** Which check-outs each holder's count came from. Read through `poolLots`. */
  pool_lots?: PoolLots;
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
  /** What it weighs with nothing in it, for gear weighed to see what is left (FR-INV-62). */
  empty_weight?: Weight | null;
  /** The weight of its full contents. A unit without one uses its generic's (FR-INV-63). */
  capacity?: Weight | null;
  /** The latest weighing, or full after Refilled; null after Unknown (FR-INV-64, FR-INV-67). */
  reading?: Reading | null;
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
  /** Where an iPhone's browser sends you to get the app (NFR-DEP-12). Unset keeps the home-screen prompt. */
  iphone_app_url?: string | null;
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
/** Users arrive in the snapshot as entities; a holder or an actor is one of them. */
export const userName = (state: State, id: string | null | undefined): string =>
  id ? (state.user?.[id]?.name as string | undefined) ?? "(unknown person)" : "";
/** Everyone who can hold gear, by name. */
export const activeUsers = (state: State): { id: string; name: string }[] =>
  Object.entries(state.user ?? {})
    .filter(([, u]) => u.active !== false)
    .map(([id, u]) => ({ id, name: (u.name as string | undefined) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));

// --- generics and units -------------------------------------------------------------------

export const isGeneric = (it: Item): boolean => Boolean(it.generic);
export const isUnit = (it: Item): boolean => Boolean(it.parent_id);
export const isPool = (it: Item): boolean => Boolean(it.pool);

/** A generic a unit can be put under: live, not folded away, not a pool. */
export const takesUnits = (g: Item): boolean =>
  Boolean(g.generic) && !g.retired && !g.merged_into && !g.deleted && !isPool(g);

export interface PoolHolderCount {
  holder_id: string;
  count: number;
}

export interface PoolCounts {
  owned: number;
  in: number;
  missing: number;
  out: PoolHolderCount[];
}

/** Owned, in, missing, and out by holder for a pool (FR-INV-36). `owned` is `in`, `missing` and every holder's count. */
export function poolCounts(it: Item): PoolCounts {
  const poolIn = it.pool_in ?? 0;
  const out = Object.entries(it.pool_out ?? {})
    .filter(([, count]) => count > 0)
    .map(([holder_id, count]) => ({ holder_id, count }));
  const missing = it.pool_missing ?? 0;
  return { owned: poolIn + out.reduce((sum, o) => sum + o.count, 0) + missing, in: poolIn, missing, out };
}

/**
 * One holder's count, split by the check-outs it came from. The counts decide: an older app build
 * can leave lots out of step, so extra lots drop off the oldest end and `unknown` is any count no
 * lot explains.
 */
export function poolLots(it: Item): { holder_id: string; count: number; lots: PoolLot[]; unknown: number }[] {
  return poolCounts(it).out.map(({ holder_id, count }) => {
    const lots = keepNewest(it.pool_lots?.[holder_id] ?? [], count);
    return { holder_id, count, lots, unknown: count - lots.reduce((sum, lot) => sum + lot.count, 0) };
  });
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

/** Every generic's units, merged ones left out, in no set order. One pass, for callers that need many generics. */
function unitsByGeneric(state: State): Map<string, Item[]> {
  const out = new Map<string, Item[]>();
  for (const it of items(state)) {
    if (!it.parent_id || it.merged_into) continue;
    const list = out.get(it.parent_id);
    if (list) list.push(it);
    else out.set(it.parent_id, [it]);
  }
  return out;
}

/** The purchase date in use and where it comes from: the unit's own, else its generic's (FR-INV-56). */
export function purchaseOf(state: State, it: Item): { date: string; generic?: Item } | null {
  if (it.purchase_date) return { date: it.purchase_date };
  const generic = parentOf(state, it);
  return generic?.purchase_date ? { date: generic.purchase_date, generic } : null;
}

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

/** Names in order, with numbers by value: "#2" before "#10". */
export const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Sort by the name on screen. */
export const byName = (state: State) => (a: Item, b: Item) =>
  compareNames(displayName(state, a), displayName(state, b));

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
 * one being labelled stays at the top of the walk. A pool has no units to add
 * one to, so it is never offered here (FR-INV-34); it takes its own code
 * through Bind instead (FR-TAG-15).
 */
export function recentGenerics(state: State, limit = 4): Item[] {
  const unitTouch = new Map<string, number>();
  for (const [id, units] of unitsByGeneric(state))
    unitTouch.set(id, Math.max(0, ...units.map((u) => Math.max(u.added_at ?? 0, u.modified_at ?? 0))));
  const list = generics(state).filter(takesUnits);
  const touched = new Map(list.map((g) => [g.id, Math.max(g.modified_at ?? 0, unitTouch.get(g.id) ?? 0)]));
  return list
    .sort(
      (a, b) => touched.get(b.id)! - touched.get(a.id)! || displayName(state, a).localeCompare(displayName(state, b)),
    )
    .slice(0, limit);
}

// --- codes --------------------------------------------------------------------------------

export type CodeStatus = "unassigned" | "assigned" | "unknown";

/** Every code on the item, newest binding first. An item may carry several (FR-TAG-20).
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
  return c.item_id ? "assigned" : "unassigned";
}

/** "Kept by Sam", with "(inactive)" once Sam is deactivated (FR-INV-59). */
export function keeperLabel(state: State, userId: string): string {
  const u = state.user?.[userId];
  return `Kept by ${userName(state, userId)}${u && u.active === false ? " (inactive)" : ""}`;
}

/** People who keep gear, by name: the Home filter's choices (FR-INV-61). Includes inactive ones. */
export const keepers = (store: Store): { id: string; name: string }[] =>
  store.memo("keepers", () => {
    const state = store.state;
    const ids = new Set(items(state).flatMap((it) => (it.home_user_id && !it.merged_into ? [it.home_user_id] : [])));
    return [...ids].map((id) => ({ id, name: userName(state, id) })).sort((x, y) => x.name.localeCompare(y.name));
  });

/** Home as people say it: "Warm locker / shelf 4" (FR-INV-02), or "Kept by Sam" (FR-INV-59). */
export function homeLabel(state: State, it: Item): string {
  if (it.home_user_id) return keeperLabel(state, it.home_user_id);
  const loc = locationName(state, it.home_location_id);
  return it.sub_location ? (loc ? `${loc} / ${it.sub_location}` : it.sub_location) : loc;
}

/** Where a returned item goes, as the Return card says it (FR-OUT-10): "Put it back: Warm locker", "Back with Sam". */
export function putBack(state: State, it: Item): string {
  const home = homeLabel(state, it);
  return it.home_user_id ? home.replace(/^Kept by /, "Back with ") : `Put it back: ${home}`;
}

export interface Filter {
  query?: string;
  location_id?: string;
  /** Gear kept by this person (FR-INV-61). */
  home_user_id?: string;
  sub_location?: string;
  status?: "in" | "out" | "missing";
  retired?: boolean;
  category_id?: string;
  needs?: Needs;
}

export const NEEDS = ["code", "location", "shelf"] as const;
export type Needs = (typeof NEEDS)[number];

/** Whether a filter narrows by location, shelf, status, category or needs. Not the search text or retired. */
export const isNarrowing = (filter: Filter): boolean =>
  Boolean(
    filter.location_id ||
      filter.home_user_id ||
      filter.sub_location ||
      filter.status ||
      filter.category_id ||
      filter.needs,
  );

/** Every item that has a code, through merges: the set a "code" need is tested against. */
const boundItems = (state: State): Set<string> =>
  new Set(codes(state).flatMap((c) => (c.item_id ? [resolveItem(state, c.item_id)] : [])));

const waiting = (it: Item, bound: Set<string>): boolean => !it.retired && !it.missing && !bound.has(it.id);

/** Per generic, its units still waiting for a code, in number order: not retired, missing or merged (FR-INV-54). */
export function unlabelledUnits(state: State): Map<string, Item[]> {
  const bound = boundItems(state);
  const byGeneric = unitsByGeneric(state);
  const out = new Map<string, Item[]>();
  for (const g of generics(state)) {
    const units = (byGeneric.get(g.id) ?? []).filter((u) => waiting(u, bound)).sort(byNumber);
    if (units.length) out.set(g.id, units);
  }
  return out;
}

/** True when the item lacks what `needs` names. A location that is gone counts as none. Twin of lacks in views.py. */
function lacks(state: State, it: Item, needs: Needs, bound: Set<string>): boolean {
  if (needs === "code") return !bound.has(it.id);
  if (needs === "location") {
    if (it.home_user_id) return false;
    const loc = it.home_location_id ? state.location?.[it.home_location_id] : undefined;
    return !loc || Boolean(loc.deleted);
  }
  if (it.home_user_id) return false;
  return !it.sub_location?.trim();
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
export const search = (state: State, filter: Filter): Item[] => searchWith(state, filter, neededCodes(state, filter));

const neededCodes = (state: State, filter: Filter): Set<string> =>
  filter.needs === "code" ? boundItems(state) : new Set<string>();

function searchWith(state: State, filter: Filter, bound: Set<string>): Item[] {
  const words = terms(filter.query);
  return movable(state)
    .filter((it) => !it.merged_into)
    .filter((it) => Boolean(it.retired) === Boolean(filter.retired))
    .filter((it) => !filter.location_id || it.home_location_id === filter.location_id)
    .filter((it) => !filter.home_user_id || it.home_user_id === filter.home_user_id)
    .filter((it) => !filter.sub_location || it.sub_location === filter.sub_location)
    .filter((it) => !filter.status || (filter.status === "missing" ? Boolean(it.missing) : it.status === filter.status))
    .filter((it) => !filter.category_id || categoriesOf(state, it).includes(filter.category_id))
    .filter((it) => matches(state, it, words))
    .filter((it) => !filter.needs || lacks(state, it, filter.needs, bound))
    .sort(byName(state));
}

/**
 * Candidates for binding a code (FR-TAG-07): everything search() finds, plus
 * a pool's own container, which is a generic and so absent from search()
 * (FR-TAG-15). A status filter other than "in" drops a pool the way it
 * drops a retired item.
 */
export function bindTargets(state: State, filter: Filter): Item[] {
  const words = terms(filter.query);
  const pools = generics(state)
    .filter(isPool)
    .filter((it) => Boolean(it.retired) === Boolean(filter.retired))
    .filter((it) => !filter.location_id || it.home_location_id === filter.location_id)
    .filter((it) => !filter.home_user_id || it.home_user_id === filter.home_user_id)
    .filter((it) => !filter.sub_location || it.sub_location === filter.sub_location)
    .filter((it) => !filter.status || filter.status === "in")
    .filter((it) => !filter.category_id || categoriesOf(state, it).includes(filter.category_id))
    .filter((it) => matches(state, it, words));
  return [...search(state, filter), ...pools].sort(byName(state));
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
  counts: { in: number; out: number; missing: number };
}

export interface PoolRow {
  kind: "pool";
  item: Item;
  name: string;
  /** Owned, in, missing, and out by holder (FR-INV-36). */
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
 * home and shelf, its categories, what it lacks (needs), and its counts. "in" means stock on the
 * shelf, "out" means anything checked out to a holder, "missing" means a
 * missing count above zero. Twin of pool_wanted in views.py.
 */
function poolWanted(state: State, pool: Item, filter: Filter, bound: Set<string>): boolean {
  if (filter.location_id && pool.home_location_id !== filter.location_id) return false;
  if (filter.home_user_id && pool.home_user_id !== filter.home_user_id) return false;
  if (filter.sub_location && pool.sub_location !== filter.sub_location) return false;
  if (filter.category_id && !categoriesOf(state, pool).includes(filter.category_id)) return false;
  if (filter.needs && !lacks(state, pool, filter.needs, bound)) return false;
  const counts = poolCounts(pool);
  if (filter.status === "in") return counts.in > 0;
  if (filter.status === "out") return counts.out.length > 0;
  if (filter.status === "missing") return counts.missing > 0;
  return true;
}

export function rows(state: State, filter: Filter): Row[] {
  const singles: Row[] = [];
  const pools: Row[] = [];
  const byParent = new Map<string, Item[]>();
  const bound = neededCodes(state, filter);
  for (const it of searchWith(state, filter, bound)) {
    const parent = it.parent_id && state.item?.[it.parent_id] ? it.parent_id : "";
    if (parent) {
      const list = byParent.get(parent);
      if (list) list.push(it);
      else byParent.set(parent, [it]);
    } else singles.push({ kind: "single", item: it, name: displayName(state, it) });
  }
  const words = terms(filter.query);
  const unfiltered = !isNarrowing(filter);
  for (const g of generics(state)) {
    if (g.merged_into || Boolean(g.retired) !== Boolean(filter.retired)) continue;
    if (!matches(state, g, words)) continue;
    if (isPool(g)) {
      if (poolWanted(state, g, filter, bound))
        pools.push({ kind: "pool", item: g, name: displayName(state, g), pool: poolCounts(g) });
    } else if (unfiltered && !byParent.has(g.id)) {
      byParent.set(g.id, []);
    }
  }
  const unitsByParent = byParent.size > 0 ? unitsByGeneric(state) : new Map<string, Item[]>();
  const grouped: Row[] = [...byParent.entries()].map(([id, units]) => {
    const parent = item(state, id) ?? ({ id } as Item);
    const all = (unitsByParent.get(id) ?? []).filter((u) => Boolean(u.retired) === Boolean(filter.retired));
    return {
      kind: "generic",
      item: parent,
      name: displayName(state, parent),
      units: units.sort(byNumber),
      counts: {
        in: all.filter((u) => u.status === "in" && !u.missing).length,
        out: all.filter((u) => u.status === "out" && !u.missing).length,
        missing: all.filter((u) => u.missing).length,
      },
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

/** Items filed under a category, retired ones too, merged ones not (FR-SET-12). Raw ids: a deleted category still finds them. */
export function categoryItems(state: State, categoryId: string): Item[] {
  return items(state)
    .filter((it) => rawCategoryIds(it).includes(categoryId) && !it.merged_into)
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
