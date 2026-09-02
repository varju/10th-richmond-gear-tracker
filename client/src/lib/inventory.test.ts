import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { openDb } from "./db";
import * as inv from "./inventory";
import { Store } from "./store";

let store: Store;
let clock = 1_000;

beforeEach(async () => {
  clock = 1_000;
  store = await Store.open(await openDb("test", new IDBFactory()), () => clock++);
  await store.setMeta({ user: { id: "alice", name: "Alice", role: "admin", active: true } });
});

async function fixture() {
  const cold = await act.createLocation(store, "Cold locker");
  const warm = await act.createLocation(store, "Warm locker");
  const tents = await act.createType(store, "4-person tent");
  const t1 = await act.createItem(store, {
    name: "Tent 1",
    home_location_id: cold,
    sub_location: "shelf 4",
    type_id: tents,
  });
  const t2 = await act.createItem(store, {
    name: "Tent 2",
    home_location_id: cold,
    sub_location: "shelf 4",
    type_id: tents,
  });
  const stove = await act.createItem(store, { name: "Stove", home_location_id: warm, sub_location: "", type_id: null });
  return { cold, warm, tents, t1, t2, stove };
}

test("search matches every word against name, home and type", async () => {
  const f = await fixture();
  const names = (filter: inv.Filter) => inv.search(store.state, filter).map((i) => i.name);
  expect(names({})).toEqual(["Stove", "Tent 1", "Tent 2"]);
  expect(names({ query: "tent 2" })).toEqual(["Tent 2"]);
  expect(names({ query: "shelf" })).toEqual(["Tent 1", "Tent 2"]);
  expect(names({ query: "4-person" })).toEqual(["Tent 1", "Tent 2"]);
  expect(names({ location_id: f.warm })).toEqual(["Stove"]);
  expect(names({ sub_location: "shelf 4", status: "in" })).toEqual(["Tent 1", "Tent 2"]);
});

test("search over 500 items stays well inside 200 ms", async () => {
  const cold = await act.createLocation(store, "Cold locker");
  const state = structuredClone(store.state);
  state.item = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => [
      `i${i}`,
      {
        name: `Item ${i} ${i % 7 === 0 ? "tent" : "tarp"}`,
        home_location_id: cold,
        sub_location: `shelf ${i % 12}`,
        status: "in",
        holder_id: null,
      },
    ]),
  );
  const started = performance.now();
  for (let i = 0; i < 20; i++) inv.search(state, { query: "tent shelf 3" });
  expect((performance.now() - started) / 20).toBeLessThan(200);
});

test("retired items are hidden unless asked for, and come back with their code", async () => {
  const f = await fixture();
  await act.bindCode(store, "ABCDEFGH23", f.t1);
  await act.retireItem(store, f.t1);
  expect(inv.search(store.state, {}).map((i) => i.name)).toEqual(["Stove", "Tent 2"]);
  expect(inv.search(store.state, { retired: true }).map((i) => i.name)).toEqual(["Tent 1"]);
  await act.unretireItem(store, f.t1);
  expect(inv.currentCode(store.state, f.t1)?.id).toBe("ABCDEFGH23");
});

test("the item's current code is the latest binding; older ones still resolve", async () => {
  const f = await fixture();
  await act.bindCode(store, "ABCDEFGH23", f.t1);
  await act.bindCode(store, "BCDEFGHJ34", f.t1);
  expect(inv.codeStatus(store.state, "ABCDEFGH23")).toBe("replaced");
  expect(inv.codeStatus(store.state, "BCDEFGHJ34")).toBe("assigned");
  expect(inv.codeStatus(store.state, "ZZZZZZZZZZ")).toBe("unknown");
  expect(inv.code(store.state, "ABCDEFGH23")?.item_id).toBe(f.t1);
});

test("updates record only what changed, with the old value", async () => {
  const f = await fixture();
  const before = store.pending.length;
  await act.updateItem(store, f.t1, { name: "Tent 1", sub_location: "shelf 5" });
  const added = store.pending.slice(before);
  expect(added.map((e) => e.payload)).toEqual([{ field: "sub_location", value: "shelf 5", old: "shelf 4" }]);
  expect(inv.item(store.state, f.t1)?.modified_at).toBeGreaterThan(inv.item(store.state, f.t1)!.added_at!);
});

test("a location in use cannot be deleted, and the error names the items", async () => {
  const f = await fixture();
  await expect(act.deleteLocation(store, f.cold)).rejects.toThrow("in use by Tent 1, Tent 2");
  await act.updateItem(store, f.stove, { home_location_id: null });
  await act.deleteLocation(store, f.warm);
  expect(inv.locations(store.state).map((l) => l.name)).toEqual(["Cold locker"]);
  expect(inv.locationName(store.state, f.warm)).toBe("Warm locker"); // hidden from pickers, still named
});

test("sub-locations are the labels in use, optionally within one location", async () => {
  const f = await fixture();
  await act.updateItem(store, f.stove, { sub_location: "bin 2" });
  expect(inv.subLocations(store.state)).toEqual(["bin 2", "shelf 4"]);
  expect(inv.subLocations(store.state, f.cold)).toEqual(["shelf 4"]);
});

test("group settings are created once, then changed", async () => {
  await act.setGroup(store, { name: "10th Richmond", code_url: "https://example.org/g/" });
  await act.setGroup(store, { name: "10th Richmond Sea Scouts" });
  expect(inv.group(store.state)).toMatchObject({
    name: "10th Richmond Sea Scouts",
    code_url: "https://example.org/g/",
  });
  expect(store.pending.map((e) => e.type)).toEqual(["created", "field_changed"]);
});

test("missing is a field, filterable, and does not change status (FR-INV-19)", async () => {
  const f = await fixture();
  await act.markMissing(store, f.stove);
  expect(inv.item(store.state, f.stove)).toMatchObject({ missing: true, status: "in" });
  const names = (filter: inv.Filter) => inv.search(store.state, filter).map((i) => i.name);
  expect(names({ status: "missing" })).toEqual(["Stove"]);
  expect(names({ status: "in" })).toEqual(["Stove", "Tent 1", "Tent 2"]);
  await act.seen(store, f.stove);
  expect(inv.item(store.state, f.stove)?.missing).toBe(false);
  // Seen again records nothing.
  const before = store.pending.length;
  await act.seen(store, f.stove);
  expect(store.pending.length).toBe(before);
});

test("a location is browsed shelf by shelf, no sub-location last, retired gear left out (FR-INV-10)", async () => {
  const f = await fixture();
  const bag = await act.createItem(store, { name: "Bag", home_location_id: f.cold, sub_location: "" });
  await act.createItem(store, { name: "Axe", home_location_id: f.cold, sub_location: "bin 1" });
  const old = await act.createItem(store, { name: "Old tent", home_location_id: f.cold, sub_location: "shelf 4" });
  await act.retireItem(store, old);
  expect(inv.bySubLocation(store.state, f.cold).map((s) => [s.sub_location, s.items.map((i) => i.name)])).toEqual([
    ["bin 1", ["Axe"]],
    ["shelf 4", ["Tent 1", "Tent 2"]],
    ["", ["Bag"]],
  ]);
  expect(inv.atLocation(store.state, f.cold).map((i) => i.id)).toContain(bag);
  expect(inv.bySubLocation(store.state, f.warm).map((s) => [s.sub_location, s.items.map((i) => i.name)])).toEqual([
    ["", ["Stove"]],
  ]);
});

test("the price is stored to the cent, and blank is no price (FR-INV-12)", async () => {
  const id = await act.createItem(store, {
    name: "Stove",
    price: "$1,249.999",
    purchase_date: "2024-03-01",
    supplier: " MEC ",
  });
  expect(inv.item(store.state, id)).toMatchObject({ price: 1250, purchase_date: "2024-03-01", supplier: "MEC" });
  await act.updateItem(store, id, { price: "" });
  expect(inv.item(store.state, id)?.price).toBeNull();
  expect(act.price("abc")).toBeNull();
  expect(act.price(-1)).toBeNull();
  expect(act.price(12.345)).toBe(12.35);
});

test("a merged duplicate leaves the list, and its sticker finds the survivor (FR-INV-13)", async () => {
  const f = await fixture();
  await act.bindCode(store, "ABCDEFGH23", f.t1);
  await act.bindCode(store, "BCDEFGHJ34", f.t2);
  await act.mergeItem(store, f.t1, f.t2);

  expect(inv.search(store.state, {}).map((i) => i.name)).toEqual(["Stove", "Tent 2"]);
  expect(inv.resolveItem(store.state, f.t1)).toBe(f.t2);
  expect(inv.resolveItem(store.state, f.t2)).toBe(f.t2);
  expect(inv.aliases(store.state, f.t2)).toEqual([f.t2, f.t1]);
  expect(inv.codesFor(store.state, f.t2).map((c) => c.id)).toEqual(["BCDEFGHJ34", "ABCDEFGH23"]);
  expect(inv.codeStatus(store.state, "ABCDEFGH23")).toBe("replaced");
  expect(inv.codeStatus(store.state, "BCDEFGHJ34")).toBe("assigned");
  expect(store.pending.at(-1)?.payload).toEqual({ field: "merged_into", value: f.t2, old: null });

  await act.unmergeItem(store, f.t1);
  expect(inv.search(store.state, {}).map((i) => i.name)).toEqual(["Stove", "Tent 1", "Tent 2"]);
  expect(inv.currentCode(store.state, f.t1)?.id).toBe("ABCDEFGH23");
});

test("a merge follows a chain, and refuses a loop", async () => {
  const f = await fixture();
  await act.mergeItem(store, f.t1, f.t2);
  await act.mergeItem(store, f.t2, f.stove);
  expect(inv.resolveItem(store.state, f.t1)).toBe(f.stove);
  expect(inv.aliases(store.state, f.stove)).toEqual([f.stove, f.t2, f.t1]);
  await act.unmergeItem(store, f.t2);
  // t1 still points at t2, so t2 cannot point back: a survivor is never itself merged.
  await expect(act.mergeItem(store, f.t2, f.t1)).rejects.toThrow("already merged");
});

test("merging needs an Admin and two items that are in, unretired and unmerged", async () => {
  const f = await fixture();
  await expect(act.mergeItem(store, f.t1, f.t1)).rejects.toThrow("itself");
  await expect(act.mergeItem(store, f.t1, "nope")).rejects.toThrow("no such item");
  await act.retireItem(store, f.stove);
  await expect(act.mergeItem(store, f.t1, f.stove)).rejects.toThrow("retired");
  await act.mergeItem(store, f.t1, f.t2);
  await expect(act.mergeItem(store, f.t1, f.t2)).rejects.toThrow("already merged");
  await store.setMeta({ user: { id: "carol", name: "Carol", role: "user", active: true } });
  await expect(act.mergeItem(store, f.t2, f.t1)).rejects.toThrow("Admins only");
});
