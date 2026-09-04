import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { openDb } from "./db";
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
