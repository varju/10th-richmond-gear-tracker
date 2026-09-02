import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { openDb } from "./db";
import * as mv from "./movement";
import * as sc from "./stockcheck";
import { Store } from "./store";

// A stock check: what is here that should not be, and what should be here but was not scanned (FR-RPT-09).
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
  const t1 = await act.createItem(store, { name: "Tent 1", home_location_id: cold, sub_location: "shelf 4" });
  const t2 = await act.createItem(store, { name: "Tent 2", home_location_id: cold, sub_location: "shelf 4" });
  const axe = await act.createItem(store, { name: "Axe", home_location_id: cold, sub_location: "bin 1" });
  const stove = await act.createItem(store, { name: "Stove", home_location_id: warm, sub_location: "" });
  const rope = await act.createItem(store, { name: "Rope", home_location_id: null, sub_location: "" });
  const old = await act.createItem(store, { name: "Old tent", home_location_id: cold, sub_location: "shelf 4" });
  await act.retireItem(store, old);
  return { cold, warm, t1, t2, axe, stove, rope, old };
}

const names = (list: { name: string }[]) => list.map((i) => i.name);

test("a shelf: scanned strangers are misplaced, unscanned residents are not seen, out gear is not expected", async () => {
  const f = await fixture();
  await mv.checkOut(store, f.t2);
  let check = sc.startCheck(f.cold, "shelf 4", 5_000);
  expect(check).toEqual({ location_id: f.cold, sub_location: "shelf 4", seen: [], started_at: 5_000 });
  expect(names(sc.notSeen(store.state, check))).toEqual(["Tent 1"]);

  check = sc.withSeen(check, f.stove);
  check = sc.withSeen(check, f.rope);
  check = sc.withSeen(check, f.t1);
  check = sc.withSeen(check, f.t1);
  expect(check.seen).toEqual([f.stove, f.rope, f.t1]);
  expect(names(sc.misplaced(store.state, check))).toEqual(["Rope", "Stove"]);
  expect(names(sc.seenHere(store.state, check))).toEqual(["Tent 1"]);
  expect(sc.notSeen(store.state, check)).toEqual([]);
});

test("a whole location counts every shelf as home", async () => {
  const f = await fixture();
  const check = sc.withSeen(sc.startCheck(f.cold, "", 5_000), f.axe);
  expect(check.sub_location).toBeUndefined();
  expect(sc.atHome({ id: f.axe, name: "Axe", status: "in", holder_id: null, home_location_id: f.cold }, check)).toBe(
    true,
  );
  expect(names(sc.notSeen(store.state, check))).toEqual(["Tent 1", "Tent 2"]);
  expect(sc.misplaced(store.state, check)).toEqual([]);
});
