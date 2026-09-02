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
