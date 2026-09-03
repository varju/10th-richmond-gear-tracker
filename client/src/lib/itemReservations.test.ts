import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { openDb } from "./db";
import * as inv from "./inventory";
import { itemReservations } from "./itemReservations";
import * as res from "./reservations";
import { Store } from "./store";

let store: Store;
let clock = 1_000;

beforeEach(async () => {
  clock = 1_000;
  store = await Store.open(await openDb("test", new IDBFactory()), () => clock++);
  await store.setMeta({ user: { id: "alice", name: "Alice", role: "admin", active: true } });
});

/** Three units of one generic, and one single item. */
async function fixture() {
  const tents = await act.createGeneric(store, { name: "4-person tent" });
  const t1 = await act.addUnit(store, tents);
  const t2 = await act.addUnit(store, tents);
  const stove = await act.createItem(store, { name: "Stove" });
  return { tents, t1, t2, stove };
}

const fall = { event: "Fall Camp", starts: "2026-10-02", ends: "2026-10-04" };
const today = "2026-09-01";

test("a single item's page shows a reservation that names it (FR-INV-37)", async () => {
  const f = await fixture();
  const r = await res.createReservation(store, { ...fall, items: [f.stove], generics: [] });
  const it = inv.item(store.state, f.stove)!;
  expect(itemReservations(store.state, it, today).map((x) => x.id)).toEqual([r]);
});

test("a unit's page shows a reservation naming it directly, and one naming its generic (FR-INV-37, FR-RES-13)", async () => {
  const f = await fixture();
  const byName = await res.createReservation(store, { ...fall, items: [f.t1], generics: [] });
  const byGeneric = await res.createReservation(store, {
    event: "Spring camp",
    starts: "2026-11-01",
    ends: "2026-11-03",
    items: [],
    generics: [{ item_id: f.tents, quantity: 1 }],
  });
  const t1 = inv.item(store.state, f.t1)!;
  expect(
    itemReservations(store.state, t1, today)
      .map((x) => x.id)
      .sort(),
  ).toEqual([byGeneric, byName].sort());

  // A generic line reserves the type, not this particular unit; the other unit sees it too.
  const t2 = inv.item(store.state, f.t2)!;
  expect(itemReservations(store.state, t2, today).map((x) => x.id)).toEqual([byGeneric]);
});

test("a generic's page shows a reservation that reserves it by quantity", async () => {
  const f = await fixture();
  const r = await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: f.tents, quantity: 2 }] });
  const generic = inv.item(store.state, f.tents)!;
  expect(itemReservations(store.state, generic, today).map((x) => x.id)).toEqual([r]);
});

test("a cancelled reservation is left off", async () => {
  const f = await fixture();
  const cancelled = await res.createReservation(store, { ...fall, items: [f.stove], generics: [] });
  await res.cancelReservation(store, cancelled);
  const it = inv.item(store.state, f.stove)!;
  expect(itemReservations(store.state, it, today)).toEqual([]);
});

test("an ended reservation is left off", async () => {
  const f = await fixture();
  await res.createReservation(store, {
    event: "Last spring",
    starts: "2026-04-01",
    ends: "2026-04-03",
    items: [f.stove],
    generics: [],
  });
  const it = inv.item(store.state, f.stove)!;
  expect(itemReservations(store.state, it, today)).toEqual([]);
});

test("nothing shown when there are no reservations for it", async () => {
  const f = await fixture();
  await res.createReservation(store, { ...fall, items: [f.t1], generics: [] });
  const stove = inv.item(store.state, f.stove)!;
  expect(itemReservations(store.state, stove, today)).toEqual([]);
});

test("a reservation naming a merged duplicate shows on the survivor's page, not the duplicate's (FR-INV-13)", async () => {
  const f = await fixture();
  const r = await res.createReservation(store, { ...fall, items: [f.t1], generics: [] });
  await act.mergeItem(store, f.t1, f.stove);

  const survivor = inv.item(store.state, f.stove)!;
  expect(itemReservations(store.state, survivor, today).map((x) => x.id)).toEqual([r]);

  const duplicate = inv.item(store.state, f.t1)!;
  expect(itemReservations(store.state, duplicate, today)).toEqual([]);
});
