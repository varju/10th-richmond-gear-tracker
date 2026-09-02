/**
 * What a person does, as events on the store. Each function records one or
 * more events and returns the entity id. Nothing here talks to the server.
 */
import type { Store } from "./store";
import { newUlid } from "./ulid";
import { blockers, type Item, item } from "./inventory";

export type ItemInput = Pick<
  Item,
  "name" | "description" | "home_location_id" | "sub_location" | "type_id" | "condition"
>;

function actor(store: Store): string {
  const id = store.meta.user?.id;
  if (!id) throw new Error("not signed in");
  return id;
}

async function created(store: Store, entity_type: string, payload: Record<string, unknown>, id = newUlid()) {
  await store.record({ entity_type, entity_id: id, type: "created", actor_id: actor(store), payload });
  return id;
}

/** One field_changed per field that actually differs, with the old value kept (FR-USR-05). */
async function changed(store: Store, entity_type: string, id: string, patch: Record<string, unknown>) {
  const before = store.state[entity_type]?.[id] ?? {};
  for (const [field, value] of Object.entries(patch)) {
    const old = before[field] ?? null;
    if ((value ?? null) === old) continue;
    await store.record({
      entity_type,
      entity_id: id,
      type: "field_changed",
      actor_id: actor(store),
      payload: { field, value: value ?? null, old },
    });
  }
}

// --- items -------------------------------------------------------------------------------

export const createItem = (store: Store, input: ItemInput) => created(store, "item", clean(input));
export const updateItem = (store: Store, id: string, patch: Partial<ItemInput>) =>
  changed(store, "item", id, clean(patch));
export const retireItem = (store: Store, id: string) => changed(store, "item", id, { retired: true });
export const unretireItem = (store: Store, id: string) => changed(store, "item", id, { retired: false });

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

// --- locations and types -------------------------------------------------------------------

export const createLocation = (store: Store, name: string) => created(store, "location", { name: name.trim() });
export const renameLocation = (store: Store, id: string, name: string) =>
  changed(store, "location", id, { name: name.trim() });
export const createType = (store: Store, name: string) => created(store, "item_type", { name: name.trim() });
export const renameType = (store: Store, id: string, name: string) =>
  changed(store, "item_type", id, { name: name.trim() });

export class InUse extends Error {
  constructor(public items: Item[]) {
    super(`in use by ${items.map((i) => i.name).join(", ")}`);
  }
}

/** Blocked while any item points at it; the error names them (FR-SET-05). */
export async function deleteLocation(store: Store, id: string): Promise<void> {
  const using = blockers(store.state, "home_location_id", id);
  if (using.length) throw new InUse(using);
  await changed(store, "location", id, { deleted: true });
}

export async function deleteType(store: Store, id: string): Promise<void> {
  const using = blockers(store.state, "type_id", id);
  if (using.length) throw new InUse(using);
  await changed(store, "item_type", id, { deleted: true });
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
