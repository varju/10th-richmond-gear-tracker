/**
 * What a person does, as events on the store. Each function records one or
 * more events and returns the entity id. Nothing here talks to the server.
 */
import type { Store } from "./store";
import { newUlid } from "./ulid";
import {
  blockers,
  categories,
  categoriesOf,
  categoryBlockers,
  codesFor,
  displayName,
  type Item,
  item,
  nextNumber,
  numberOf,
  numberTaken,
  unitsOf,
} from "./inventory";

/** What the item form holds. */
export type ItemInput = Pick<
  Item,
  "name" | "description" | "home_location_id" | "sub_location" | "purchase_date" | "category_ids"
>;

/** What the unit form holds. A unit has no name: its number and nickname make it (FR-INV-23). */
export interface UnitInput {
  parent_id: string;
  /** Text, because the gear may read "A" or "3b". Trimmed, never empty. */
  number: string;
  nickname?: string | null;
  home_location_id?: string | null;
  sub_location?: string;
}

/** A number as it is stored: what was typed, trimmed. Blank is not a number (FR-INV-23). */
export function unitNumber(value: string): string {
  const number = value.trim();
  if (!number) throw new Error("a unit needs a number");
  return number;
}

function actor(store: Store): string {
  const id = store.meta.user?.id;
  if (!id) throw new Error("not signed in");
  return id;
}

async function created(store: Store, entity_type: string, payload: Record<string, unknown>, id = newUlid()) {
  await store.record({ entity_type, entity_id: id, type: "created", actor_id: actor(store), payload });
  return id;
}

/** True when both are arrays holding the same members in the same order. */
function sameArray(a: unknown, b: unknown): boolean {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * One field_changed per field that actually differs, with the old value kept
 * (FR-USR-05). `oldOverrides` stands in for a field's raw stored value when a
 * caller needs the old value read a different way, e.g. through a fallback
 * (FR-SET-07).
 *
 * Refuses an id that does not exist: without this, a caller that skips its own
 * check (an item, location or category already gone) would write a
 * field_changed against nothing, and replay would materialise a phantom entity.
 */
async function changed(
  store: Store,
  entity_type: string,
  id: string,
  patch: Record<string, unknown>,
  oldOverrides: Record<string, unknown> = {},
) {
  const existing = store.state[entity_type]?.[id];
  if (!existing) throw new Error(`no such ${entity_type}`);
  const before = { ...existing, ...oldOverrides };
  for (const [field, value] of Object.entries(patch)) {
    const old = before[field] ?? null;
    if (sameArray(value, old) || (value ?? null) === old) continue;
    await store.record({
      entity_type,
      entity_id: id,
      type: "field_changed",
      actor_id: actor(store),
      payload: { field, value: value ?? null, old },
    });
  }
}

/** Unique, in categories(state) order, so two devices record the same value for the same set (FR-SET-07). */
function normaliseCategoryIds(store: Store, ids: string[]): string[] {
  const chosen = new Set(ids);
  return categories(store.state)
    .map((c) => c.id)
    .filter((id) => chosen.has(id));
}

/** category_ids, sorted and deduplicated, when the input carries it. Left untouched otherwise. */
function withCategoryIds<T extends { category_ids?: string[] }>(store: Store, input: T): T {
  if (input.category_ids === undefined) return input;
  return { ...input, category_ids: normaliseCategoryIds(store, input.category_ids) };
}

// --- items -------------------------------------------------------------------------------

export const createItem = (store: Store, input: ItemInput) =>
  created(store, "item", clean(withCategoryIds(store, input)));

/**
 * The old value for category_ids is read through the fallback (FR-SET-07): an
 * item that only ever had category_id must not look "changed" by a patch that
 * leaves its resolved categories the same.
 */
export async function updateItem(store: Store, id: string, patch: Partial<ItemInput>): Promise<void> {
  const prepared = withCategoryIds(store, patch);
  const overrides: Record<string, unknown> = {};
  if (prepared.category_ids !== undefined) {
    const current = item(store.state, id);
    overrides.category_ids = current ? categoriesOf(store.state, current) : [];
  }
  await changed(store, "item", id, clean(prepared), overrides);
}

/** One thing the group owns several of. No code, no movements; its units carry both (FR-INV-21). */
export const createGeneric = (store: Store, input: ItemInput) =>
  created(store, "item", { ...clean(withCategoryIds(store, input)), generic: true });

/** A counted stack, not units (FR-INV-34): always generic, with no code and no units of its own. */
export const createPool = (store: Store, input: ItemInput, quantity: number) =>
  created(store, "item", { ...clean(withCategoryIds(store, input)), generic: true, pool: true, quantity });

/** One of them, numbered under its generic (FR-INV-22). The number is checked here, on this device. */
export async function createUnit(store: Store, input: UnitInput): Promise<string> {
  const parent = item(store.state, input.parent_id);
  if (!parent?.generic) throw new Error("not a generic item");
  const number = unitNumber(input.number);
  if (numberTaken(store.state, input.parent_id, number)) throw new Error(`#${number} is taken`);
  return created(store, "item", clean({ ...input, number }));
}

/** The next unit of a generic, taking its number and its default home (FR-INV-24, FR-INV-29). */
export function addUnit(store: Store, genericId: string, number?: string): Promise<string> {
  const parent = item(store.state, genericId);
  if (!parent) throw new Error("no such item");
  return createUnit(store, {
    parent_id: genericId,
    number: number ?? nextNumber(store.state, genericId),
    home_location_id: parent.home_location_id ?? null,
    sub_location: parent.sub_location ?? "",
  });
}

/**
 * Mark a single item as generic (FR-INV-26). A new generic takes its name,
 * description and home; the item becomes a unit under it, with the number the
 * person confirmed, and loses the name it no longer needs. Nothing in its
 * history is rewritten, so its code, movements and tickets stay where they
 * are. Photos stay on the unit: only the server may say a photo exists, so a
 * device cannot copy one across.
 */
export async function makeGeneric(store: Store, id: string, number = "1"): Promise<string> {
  const it = item(store.state, id);
  if (!it) throw new Error("no such item");
  if (it.generic) throw new Error("already generic");
  if (it.parent_id) throw new Error("this is already one of several");
  const first = unitNumber(number);
  const genericId = await createGeneric(store, {
    name: it.name ?? "",
    description: it.description ?? "",
    home_location_id: it.home_location_id ?? null,
    sub_location: it.sub_location ?? "",
  });
  await changed(store, "item", id, { parent_id: genericId, number: first, name: null });
  return genericId;
}

/**
 * A single item, or a generic with no units (FR-INV-40), becomes a counted
 * stack (FR-INV-34), the way a single item becomes a generic (FR-INV-26). A
 * pool has no units of its own, so this cannot go on being the thing itself:
 * it folds into a fresh pool entity, the way a duplicate record folds into
 * its survivor (FR-INV-13). Its movements and tickets (a single item) or its
 * name and description (an empty generic) stay reachable through the fold,
 * and a single item's code now opens the pool (FR-TAG-15); nothing in its
 * history is rewritten. A single item must be in, the same guard mergeItem
 * and makeSingle use; a generic must have no units left.
 */
export async function makePool(store: Store, id: string, quantity: number): Promise<string> {
  const it = item(store.state, id);
  if (!it) throw new Error("no such item");
  if (it.parent_id) throw new Error("this is already one of several");
  if (it.merged_into) throw new Error("already merged");
  if (it.generic) {
    if (it.pool) throw new Error("already several");
    if (unitsOf(store.state, id).length) throw new Error("remove its units first");
  } else if (it.status !== "in") {
    throw new Error("return it first");
  }
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("pick a quantity of at least 1");
  const poolId = await createPool(
    store,
    {
      name: it.name ?? "",
      description: it.description ?? "",
      home_location_id: it.home_location_id ?? null,
      sub_location: it.sub_location ?? "",
      purchase_date: it.purchase_date ?? null,
      category_ids: categoriesOf(store.state, it),
    },
    quantity,
  );
  await changed(store, "item", id, { merged_into: poolId });
  return poolId;
}

/** A unit's own fields: its number under the parent, and its nickname (FR-INV-23). */
export async function updateUnit(
  store: Store,
  id: string,
  patch: { number?: string; nickname?: string | null },
): Promise<void> {
  const it = item(store.state, id);
  if (!it?.parent_id) throw new Error("not a unit");
  const fields: Record<string, unknown> = { ...patch };
  if (patch.number !== undefined) {
    const number = unitNumber(patch.number);
    if (numberTaken(store.state, it.parent_id, number, id)) throw new Error(`#${number} is taken`);
    fields.number = number;
  }
  await changed(store, "item", id, fields);
}

/** A unit was filed under the wrong generic (FR-INV-28). Its history moves with it; a taken number is bumped. */
export async function moveUnit(store: Store, id: string, parentId: string): Promise<void> {
  const it = item(store.state, id);
  const parent = item(store.state, parentId);
  if (!it?.parent_id) throw new Error("not a unit");
  if (!parent?.generic) throw new Error("not a generic item");
  if (parentId === it.parent_id) return;
  const mine = numberOf(it);
  const number = numberTaken(store.state, parentId, mine) ? nextNumber(store.state, parentId) : mine;
  await changed(store, "item", id, { parent_id: parentId, number });
}

/** A generic goes only when every unit has gone; retiring the last unit leaves it (FR-INV-27). */
export async function retireItem(store: Store, id: string): Promise<void> {
  const it = item(store.state, id);
  if (it?.generic && unitsOf(store.state, id).some((u) => !u.retired)) {
    throw new Error("retire its units first");
  }
  await changed(store, "item", id, { retired: true });
}

export const unretireItem = (store: Store, id: string) => changed(store, "item", id, { retired: false });

/**
 * A record made in error, off every list for good (FR-INV-32). One field on the
 * item, like a location's `deleted`: the events stay in the log and nothing in
 * the app brings it back. Its codes are released (FR-TAG-14), so a sticker
 * scanned later offers create-or-bind instead of a dead record. Retire
 * (FR-INV-04) is the one for gear written off.
 *
 * Admins only, and only an item that is in. A generic goes after its units, so
 * nothing is left pointing at a name that is gone.
 */
export async function deleteItem(store: Store, id: string): Promise<void> {
  if (store.meta.user?.role !== "admin") throw new Error("Admins only");
  const it = item(store.state, id);
  if (!it) throw new Error("no such item");
  if (it.merged_into) throw new Error("this item was merged into another");
  if (it.status === "out") throw new Error("return it first");
  if (it.generic && unitsOf(store.state, id).length) throw new Error("delete its units first");
  for (const code of codesFor(store.state, id)) await releaseCode(store, code.id);
  await changed(store, "item", id, { deleted: true });
}

/** Lost, not written off (FR-INV-19). A field, not a status: it can be out and missing. */
export const markMissing = (store: Store, id: string) => changed(store, "item", id, { missing: true });
export const clearMissing = (store: Store, id: string) => changed(store, "item", id, { missing: false });

/** The item turned up: a scan, a check-in, a stock check. Clears missing; records nothing otherwise. */
export async function seen(store: Store, id: string): Promise<void> {
  if (item(store.state, id)?.missing) await clearMissing(store, id);
}

function clean<T extends object>(input: T): Record<string, unknown> {
  // Empty strings are absence. Keep nulls: they clear a field.
  return Object.fromEntries(
    Object.entries(input).map(([k, v]) => [
      k,
      typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.trim() : v,
    ]),
  );
}

/**
 * A single item becomes one of a generic's units (FR-INV-30). It keeps its
 * home, its code, its movements and its tickets, and loses the name it no
 * longer needs; the generic's name is the one people read.
 */
export async function joinGeneric(store: Store, id: string, genericId: string, number: string): Promise<void> {
  const it = item(store.state, id);
  const parent = item(store.state, genericId);
  if (!it) throw new Error("no such item");
  if (it.generic) throw new Error("this is already a name for several");
  if (it.parent_id) throw new Error("this is already one of several");
  if (!parent?.generic) throw new Error("not a generic item");
  const mine = unitNumber(number);
  if (numberTaken(store.state, genericId, mine)) throw new Error(`#${mine} is taken`);
  await changed(store, "item", id, { parent_id: genericId, number: mine, name: null });
}

/**
 * The same thing, entered twice as two items, put under one name (FR-INV-30).
 * Both are real, so neither disappears: they become units of one generic.
 * Picking a single item makes a generic from that item's name; picking a
 * generic, or any of its units, joins the generic already there.
 *
 * This is not a merge (FR-INV-13). A merge is for one thing recorded twice,
 * where one record has to go.
 */
export async function groupWith(
  store: Store,
  id: string,
  otherId: string,
  numbers: { mine: string; other?: string },
): Promise<string> {
  const it = item(store.state, id);
  const other = item(store.state, otherId);
  if (!it || !other) throw new Error("no such item");
  if (id === otherId) throw new Error("an item cannot be grouped with itself");
  if (it.generic) throw new Error("this is already a name for several");
  if (it.parent_id) throw new Error("this is already one of several");
  const mine = unitNumber(numbers.mine);
  const theirs = unitNumber(numbers.other ?? "1");
  const fresh = !other.generic && !other.parent_id;
  // Checked before anything is written, so a clash cannot leave half a group behind.
  if (fresh && mine === theirs) throw new Error("the two need different numbers");
  const genericId = fresh ? await makeGeneric(store, otherId, theirs) : other.parent_id ?? other.id;
  await joinGeneric(store, id, genericId, mine);
  return genericId;
}

/**
 * Fold a duplicate into the item it doubles (FR-INV-13). One field on the duplicate; nothing is rewritten.
 * Admins only; the duplicate must be in, and neither item retired or already merged.
 */
export async function mergeItem(store: Store, duplicateId: string, survivorId: string): Promise<void> {
  if (store.meta.user?.role !== "admin") throw new Error("Admins only");
  const dup = item(store.state, duplicateId);
  const survivor = item(store.state, survivorId);
  if (!dup || !survivor) throw new Error("no such item");
  if (duplicateId === survivorId) throw new Error("an item cannot be merged into itself");
  if (dup.merged_into || survivor.merged_into) throw new Error("already merged");
  if (dup.retired || survivor.retired) throw new Error("retired items cannot be merged");
  if (dup.status !== "in") throw new Error("return it first");
  await changed(store, "item", duplicateId, { merged_into: survivorId });
}

/** Undo a merge. The pointer goes, and both items stand on their own again. */
export const unmergeItem = (store: Store, id: string) => changed(store, "item", id, { merged_into: null });

/**
 * A generic becomes a single item again, the reverse of makeGeneric
 * (FR-INV-26). With one unit (FR-INV-33), that unit keeps its id, code and
 * history; takes the generic's name, description, categories and purchase
 * details. Its own home wins when it has one, so a unit already moved off
 * the generic's default is not moved back; otherwise it takes the generic's
 * default home (FR-INV-29). Its number and nickname go, the nickname landing
 * on the end of the description since a single item has no number to carry
 * it. With no units (FR-INV-39), there is nothing to fall back on: a fresh
 * item takes the generic's name, description, categories and purchase
 * details instead, with no code yet. Either way the generic is then folded
 * into the result, like a duplicate record (FR-INV-13): its photos and
 * record stay readable, and nothing else on it changes.
 *
 * Anyone signed in may do it. A surviving unit must be in, the same guard
 * mergeItem uses, so gear is not reshaped out from under whoever has it.
 */
export async function makeSingle(store: Store, genericId: string): Promise<string> {
  const generic = item(store.state, genericId);
  if (!generic) throw new Error("no such item");
  if (!generic.generic) throw new Error("not a generic item");
  if (generic.merged_into) throw new Error("already merged");
  const units = unitsOf(store.state, genericId);
  if (units.length > 1) throw new Error("needs no more than one unit");
  if (units.length === 0) {
    const id = await createItem(store, {
      name: generic.name ?? "",
      description: generic.description ?? "",
      home_location_id: generic.home_location_id ?? null,
      sub_location: generic.sub_location ?? "",
      purchase_date: generic.purchase_date ?? null,
      category_ids: categoriesOf(store.state, generic),
    });
    await changed(store, "item", genericId, { merged_into: id });
    return id;
  }
  const unit = units[0]!;
  if (unit.status !== "in") throw new Error("return it first");

  const nickname = unit.nickname?.trim();
  const description = nickname
    ? [generic.description, nickname].filter(Boolean).join(" · ")
    : generic.description ?? "";

  await changed(
    store,
    "item",
    unit.id,
    clean({
      parent_id: null,
      number: null,
      nickname: null,
      name: generic.name ?? "",
      description,
      category_ids: normaliseCategoryIds(store, categoriesOf(store.state, generic)),
      home_location_id: unit.home_location_id ?? generic.home_location_id ?? null,
      sub_location: unit.home_location_id ? unit.sub_location ?? "" : generic.sub_location ?? "",
      purchase_date: unit.purchase_date ?? generic.purchase_date ?? null,
    }),
  );
  await changed(store, "item", genericId, { merged_into: unit.id });
  return unit.id;
}

// --- codes -------------------------------------------------------------------------------

/** Put a printed code on an item: at creation, or to replace a lost sticker (FR-TAG-04, FR-TAG-07). */
export async function bindCode(store: Store, codeId: string, itemId: string): Promise<void> {
  if (!item(store.state, itemId)) throw new Error("no such item");
  await store.record({
    entity_type: "code",
    entity_id: codeId,
    type: "code_bound",
    actor_id: actor(store),
    payload: { item_id: itemId },
  });
}

/** Take a code off its item, on purpose, back to unassigned (FR-TAG-14). The sticker is already off the gear. */
export async function releaseCode(store: Store, codeId: string): Promise<void> {
  await store.record({
    entity_type: "code",
    entity_id: codeId,
    type: "code_released",
    actor_id: actor(store),
    payload: {},
  });
}

// --- locations -------------------------------------------------------------------

export const createLocation = (store: Store, name: string) => created(store, "location", { name: name.trim() });
export const renameLocation = (store: Store, id: string, name: string) =>
  changed(store, "location", id, { name: name.trim() });
export class InUse extends Error {
  constructor(public names: string[]) {
    super(`in use by ${names.join(", ")}`);
  }
}

/** Blocked while any item points at it; the error names them (FR-SET-05). */
export async function deleteLocation(store: Store, id: string): Promise<void> {
  const using = blockers(store.state, id);
  if (using.length) throw new InUse(using.map((it) => displayName(store.state, it)));
  await changed(store, "location", id, { deleted: true });
}

// --- categories ------------------------------------------------------------------

export const createCategory = (store: Store, name: string) => created(store, "category", { name: name.trim() });
export const renameCategory = (store: Store, id: string, name: string) =>
  changed(store, "category", id, { name: name.trim() });

/** Blocked while any item points at it; the error names them (FR-SET-05). */
export async function deleteCategory(store: Store, id: string): Promise<void> {
  const using = categoryBlockers(store.state, id);
  if (using.length) throw new InUse(using.map((it) => displayName(store.state, it)));
  await changed(store, "category", id, { deleted: true });
}

// --- group ---------------------------------------------------------------------------------

/** Admin only; the server refuses it from anyone else. */
export async function setGroup(
  store: Store,
  patch: { name?: string; code_url?: string; contact?: string; overdue_days?: number | null },
): Promise<void> {
  if (!store.state.setting?.group) await created(store, "setting", clean(patch), "group");
  else await changed(store, "setting", "group", clean(patch));
}
