/**
 * Reading the state: what an item, a location, a code look like, and the
 * questions the screens ask of them. Pure functions over Store.state.
 */
import type { Fields, Movement, Note, State } from "./replay";

export interface Item {
  id: string;
  name: string;
  description?: string;
  home_location_id?: string | null;
  sub_location?: string;
  type_id?: string | null;
  condition?: string;
  retired?: boolean;
  status: "in" | "out";
  holder_id: string | null;
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

export interface ItemType {
  id: string;
  name: string;
  deleted?: boolean;
}

export interface Code {
  id: string;
  item_id?: string;
  bound_at?: number;
}

export interface GroupSetting {
  name?: string;
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

export const items = (state: State): Item[] => withId<Item>(state.item);
export const locations = (state: State): Location[] => withId<Location>(state.location).filter((l) => !l.deleted);
export const itemTypes = (state: State): ItemType[] => withId<ItemType>(state.item_type).filter((t) => !t.deleted);
export const codes = (state: State): Code[] => withId<Code>(state.code);
export const group = (state: State): GroupSetting => (state.setting?.group ?? {}) as GroupSetting;

export const item = (state: State, id: string): Item | undefined =>
  state.item?.[id] ? ({ id, ...state.item[id] } as Item) : undefined;
export const code = (state: State, id: string): Code | undefined =>
  state.code?.[id] ? ({ id, ...state.code[id] } as Code) : undefined;
export const locationName = (state: State, id: string | null | undefined): string =>
  id ? (state.location?.[id]?.name as string | undefined) ?? "(unknown location)" : "";
export const typeName = (state: State, id: string | null | undefined): string =>
  id ? (state.item_type?.[id]?.name as string | undefined) ?? "(unknown type)" : "";

export type CodeStatus = "unassigned" | "assigned" | "replaced" | "unknown";

/** Every code that has ever been on the item, newest binding first. The first is its current code. */
export function codesFor(state: State, itemId: string): Code[] {
  return codes(state)
    .filter((c) => c.item_id === itemId)
    .sort((a, b) => (b.bound_at ?? 0) - (a.bound_at ?? 0) || (a.id < b.id ? 1 : -1));
}

export const currentCode = (state: State, itemId: string): Code | undefined => codesFor(state, itemId)[0];

/** What a scan of this code means (architecture.md, "Code lifecycle"). */
export function codeStatus(state: State, id: string): CodeStatus {
  const c = code(state, id);
  if (!c) return "unknown";
  if (!c.item_id) return "unassigned";
  return currentCode(state, c.item_id)?.id === id ? "assigned" : "replaced";
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
  type_id?: string;
  status?: "in" | "out";
  retired?: boolean;
}

/** Search as you type (FR-INV-07): every word must appear somewhere in the name, home or type. */
export function search(state: State, filter: Filter): Item[] {
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return items(state)
    .filter((it) => Boolean(it.retired) === Boolean(filter.retired))
    .filter((it) => !filter.location_id || it.home_location_id === filter.location_id)
    .filter((it) => !filter.sub_location || it.sub_location === filter.sub_location)
    .filter((it) => !filter.type_id || it.type_id === filter.type_id)
    .filter((it) => !filter.status || it.status === filter.status)
    .filter((it) => {
      if (words.length === 0) return true;
      const hay = `${it.name} ${homeLabel(state, it)} ${typeName(state, it.type_id)}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The sub-location labels in use, for a suggestion list. Labels, not entities (FR-SET-03). */
export function subLocations(state: State, locationId?: string): string[] {
  const seen = new Set<string>();
  for (const it of items(state)) {
    if (it.sub_location && (!locationId || it.home_location_id === locationId)) seen.add(it.sub_location);
  }
  return [...seen].sort();
}

/** Items that stop a location or type being deleted (FR-SET-05). Retired items count: they can come back. */
export function blockers(state: State, field: "home_location_id" | "type_id", id: string): Item[] {
  return items(state)
    .filter((it) => it[field] === id)
    .sort((a, b) => a.name.localeCompare(b.name));
}
