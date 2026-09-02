import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { openDb } from "./db";
import * as mv from "./movement";
import * as res from "./reservations";
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
  const t1 = await act.createItem(store, { name: "Tent 1", home_location_id: cold, type_id: tents });
  const t2 = await act.createItem(store, { name: "Tent 2", home_location_id: cold, type_id: tents });
  const t3 = await act.createItem(store, { name: "Tent 3", home_location_id: cold, type_id: tents });
  const stove = await act.createItem(store, { name: "Stove", home_location_id: warm });
  const tarp = await act.createItem(store, { name: "Tarp", home_location_id: warm });
  return { cold, warm, tents, t1, t2, t3, stove, tarp };
}

const fall = { event: "Fall Camp", starts: "2026-10-02", ends: "2026-10-04" };

test("today is the calendar day in Vancouver, not UTC (NFR-DATA-12)", () => {
  // 2026-09-02T03:00Z is still the evening of the 1st on the west coast.
  expect(res.todayIso(Date.UTC(2026, 8, 2, 3))).toBe("2026-09-01");
  expect(res.todayIso(Date.UTC(2026, 8, 2, 12))).toBe("2026-09-02");
});

test("upcoming and past split on today; cancelled ones are gone", async () => {
  const a = await res.createReservation(store, { ...fall, items: [], types: [] });
  const b = await res.createReservation(store, {
    event: "Spring camp",
    starts: "2026-04-10",
    ends: "2026-04-12",
    items: [],
    types: [],
  });
  const c = await res.createReservation(store, { ...fall, event: "Cub camp", items: [], types: [] });
  await res.cancelReservation(store, c);
  expect(res.upcoming(store.state, "2026-09-01").map((r) => r.id)).toEqual([a]);
  expect(res.past(store.state, "2026-09-01").map((r) => r.id)).toEqual([b]);
  expect(res.reservation(store.state, c)?.cancelled).toBe(true);
});

test("an item named in two overlapping reservations is a conflict, named by event (FR-RES-05)", async () => {
  const f = await fixture();
  await res.createReservation(store, { ...fall, items: [f.t1, f.stove], types: [] });

  const same = res.conflicts(store.state, {
    event: "Cubs",
    starts: "2026-10-04",
    ends: "2026-10-05",
    items: [f.t1],
    types: [],
  });
  expect(same).toEqual([{ id: expect.any(String), event: "Fall Camp", detail: "Tent 1" }]);

  const later = res.conflicts(store.state, {
    event: "Cubs",
    starts: "2026-10-05",
    ends: "2026-10-06",
    items: [f.t1],
    types: [],
  });
  expect(later).toEqual([]);

  const other = res.conflicts(store.state, { ...fall, event: "Cubs", items: [f.t2], types: [] });
  expect(other).toEqual([]);
});

test("a type conflicts when demand across the dates exceeds what we own (FR-RES-15)", async () => {
  const f = await fixture();
  // Fall Camp names one tent and wants one more of the type: two of three.
  await res.createReservation(store, { ...fall, items: [f.t1], types: [{ type_id: f.tents, quantity: 1 }] });

  const one = res.conflicts(store.state, {
    ...fall,
    event: "Cubs",
    items: [],
    types: [{ type_id: f.tents, quantity: 1 }],
  });
  expect(one).toEqual([]);

  const two = res.conflicts(store.state, {
    ...fall,
    event: "Cubs",
    items: [],
    types: [{ type_id: f.tents, quantity: 2 }],
  });
  expect(two).toEqual([{ id: expect.any(String), event: "Fall Camp", detail: "4 × 4-person tent, we have 3" }]);

  // Retired gear does not count as owned.
  await act.retireItem(store, f.t3);
  expect(
    res.conflicts(store.state, { ...fall, event: "Cubs", items: [], types: [{ type_id: f.tents, quantity: 1 }] }),
  ).toHaveLength(1);
});

test("editing a reservation does not conflict with itself", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, { ...fall, items: [f.t1], types: [{ type_id: f.tents, quantity: 2 }] });
  expect(
    res.conflicts(store.state, { ...fall, items: [f.t1, f.t2], types: [{ type_id: f.tents, quantity: 1 }] }, id),
  ).toEqual([]);
  expect(res.conflicts(store.state, { ...fall, items: [f.t1], types: [] })).toHaveLength(1);
});

test("remaining is what is not yet out under the event, by home; a type ticks off on any of its items", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, {
    ...fall,
    items: [f.stove, f.t1, f.tarp],
    types: [{ type_id: f.tents, quantity: 2 }],
  });
  const r = res.reservation(store.state, id)!;

  let rem = res.remaining(store.state, r);
  expect(rem.items.map((i) => i.name)).toEqual(["Tent 1", "Stove", "Tarp"]);
  expect(rem.types).toEqual([{ type: expect.objectContaining({ name: "4-person tent" }), quantity: 2, done: 0 }]);
  expect(res.isPacked(rem)).toBe(false);

  await mv.checkOut(store, f.t1, { event: "Fall Camp" });
  await mv.checkOut(store, f.t2, { event: "Fall Camp" });
  await mv.checkOut(store, f.stove, { event: "Other trip" }); // out, but not for us
  rem = res.remaining(store.state, r);
  expect(rem.items.map((i) => i.name)).toEqual(["Stove", "Tarp"]);
  // Tent 1 is named, so it is its own line; only Tent 2 counts toward the type.
  expect(rem.types[0]!.done).toBe(1);

  await mv.checkIn(store, f.stove);
  await mv.checkOut(store, f.stove, { event: "Fall Camp" });
  await mv.checkOut(store, f.tarp, { event: "Fall Camp" });
  await mv.checkOut(store, f.t3, { event: "Fall Camp" });
  rem = res.remaining(store.state, r);
  expect(rem.items).toEqual([]);
  expect(rem.types[0]!.done).toBe(2);
  expect(res.isPacked(rem)).toBe(true);
});

test("an update records one field_changed per changed field, with the old list kept", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, { ...fall, items: [f.t1], types: [] });
  await res.updateReservation(store, id, { items: [f.t1, f.t2], event: "Fall Camp", ends: "2026-10-05" });
  const changes = store.pending.filter((e) => e.type === "field_changed").map((e) => e.payload);
  expect(changes).toEqual([
    { field: "items", value: [f.t1, f.t2], old: [f.t1] },
    { field: "ends", value: "2026-10-05", old: "2026-10-04" },
  ]);
  expect(res.reservation(store.state, id)).toMatchObject({ items: [f.t1, f.t2], ends: "2026-10-05" });
});
