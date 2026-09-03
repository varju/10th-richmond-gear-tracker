import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { changes, describeValue } from "./audit";
import { openDb } from "./db";
import { Store } from "./store";

let store: Store;
let clock = 1_000;

beforeEach(async () => {
  clock = 1_000;
  store = await Store.open(await openDb("test", new IDBFactory()), () => clock++);
  await store.setMeta({ user: { id: "alice", name: "Alice", role: "admin", active: true } });
});

test("changes list the record's edits newest first, with names for ids (FR-USR-09)", async () => {
  const cold = await act.createLocation(store, "Cold locker");
  const warm = await act.createLocation(store, "Warm locker");
  const tent = await act.createItem(store, { name: "Tent", home_location_id: cold });
  await act.updateItem(store, tent, { home_location_id: warm, price: "249.99" });
  await act.retireItem(store, tent);

  const rows = changes(store, tent).map((c) => (c.kind === "created" ? c.label : `${c.label}: ${c.old} → ${c.new}`));
  expect(rows).toEqual([
    "Retired: — → Yes",
    "Price: — → $249.99",
    "Home location: Cold locker → Warm locker",
    "Created",
  ]);
  expect(changes(store, tent).every((c) => c.actor_id === "alice")).toBe(true);
});

test("a category change names the category (FR-USR-09, FR-SET-07)", async () => {
  const tents = await act.createCategory(store, "Tents");
  const tent = await act.createItem(store, { name: "Tent" });
  await act.updateItem(store, tent, { category_id: tents });

  const rows = changes(store, tent).map((c) => (c.kind === "created" ? c.label : `${c.label}: ${c.old} → ${c.new}`));
  expect(rows).toEqual(["Category: — → Tents", "Created"]);
});

test("values read as a person would", async () => {
  const other = await act.createItem(store, { name: "Tent 2" });
  const state = store.state;
  expect(describeValue(state, "name", null)).toBe("—");
  expect(describeValue(state, "retired", false)).toBe("No");
  expect(describeValue(state, "merged_into", other)).toBe("Tent 2");
  expect(describeValue(state, "parent_id", "nope")).toBe("(unknown item)");
  expect(describeValue(state, "sub_location", "shelf 4")).toBe("shelf 4");
});
