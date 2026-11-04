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

test("writing a field on an id that does not exist is refused, not silently recorded", async () => {
  await expect(act.retireItem(store, "nope")).rejects.toThrow("no such item");
  await expect(act.renameLocation(store, "nope", "New name")).rejects.toThrow("no such location");
  await expect(act.renameCategory(store, "nope", "New name")).rejects.toThrow("no such category");
  expect(store.pending).toEqual([]);
});

test("addUnits makes the units in order, numbered on from the last", async () => {
  const empty = await act.createGeneric(store, { name: "Tent" });
  expect(await act.addUnits(store, empty, 2)).toHaveLength(2);
  const mixed = await act.createGeneric(store, { name: "Fly" });
  await act.addUnit(store, mixed, "A");
  await act.addUnit(store, mixed, "3");
  const ids = await act.addUnits(store, mixed, 2);
  expect(ids.map((id) => inv.item(store.state, id)?.number)).toEqual(["4", "5"]);
  const [third] = await act.addUnits(store, empty, 1);
  expect(inv.item(store.state, third!)?.number).toBe("3");
});

test("addUnits refuses a count outside 1 to 100 or not whole", async () => {
  const g = await act.createGeneric(store, { name: "Tent" });
  for (const n of [0, 101, 1.5]) await expect(act.addUnits(store, g, n)).rejects.toThrow("count must be");
  expect(store.pending.filter((e) => e.type === "created")).toHaveLength(1);
});
