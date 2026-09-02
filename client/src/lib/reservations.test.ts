import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import type { ServerEvent } from "./api";
import * as inv from "./inventory";
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

/** Three units of one generic, and two single items. */
async function fixture() {
  const cold = await act.createLocation(store, "Cold locker");
  const warm = await act.createLocation(store, "Warm locker");
  const tents = await act.createGeneric(store, { name: "4-person tent", home_location_id: cold });
  const t1 = await act.addUnit(store, tents);
  const t2 = await act.addUnit(store, tents);
  const t3 = await act.addUnit(store, tents);
  const stove = await act.createItem(store, { name: "Stove", home_location_id: warm });
  const tarp = await act.createItem(store, { name: "Tarp", home_location_id: warm });
  return { cold, warm, tents, t1, t2, t3, stove, tarp };
}

const shown = (it: { id: string }) => inv.displayName(store.state, inv.item(store.state, it.id)!);

const fall = { event: "Fall Camp", starts: "2026-10-02", ends: "2026-10-04" };

test("today is the calendar day in Vancouver, not UTC (NFR-DATA-12)", () => {
  // 2026-09-02T03:00Z is still the evening of the 1st on the west coast.
  expect(res.todayIso(Date.UTC(2026, 8, 2, 3))).toBe("2026-09-01");
  expect(res.todayIso(Date.UTC(2026, 8, 2, 12))).toBe("2026-09-02");
});

test("upcoming and past split on today; cancelled ones are gone", async () => {
  const a = await res.createReservation(store, { ...fall, items: [], generics: [] });
  const b = await res.createReservation(store, {
    event: "Spring camp",
    starts: "2026-04-10",
    ends: "2026-04-12",
    items: [],
    generics: [],
  });
  const c = await res.createReservation(store, { ...fall, event: "Cub camp", items: [], generics: [] });
  await res.cancelReservation(store, c);
  expect(res.upcoming(store.state, "2026-09-01").map((r) => r.id)).toEqual([a]);
  expect(res.past(store.state, "2026-09-01").map((r) => r.id)).toEqual([b]);
  expect(res.reservation(store.state, c)?.cancelled).toBe(true);
});

test("an item named in two overlapping reservations is a conflict, named by event (FR-RES-05)", async () => {
  const f = await fixture();
  await res.createReservation(store, { ...fall, items: [f.t1, f.stove], generics: [] });

  const same = res.conflicts(store.state, {
    event: "Cubs",
    starts: "2026-10-04",
    ends: "2026-10-05",
    items: [f.t1],
    generics: [],
  });
  expect(same).toEqual([{ id: expect.any(String), event: "Fall Camp", detail: "4-person tent #1" }]);

  const later = res.conflicts(store.state, {
    event: "Cubs",
    starts: "2026-10-05",
    ends: "2026-10-06",
    items: [f.t1],
    generics: [],
  });
  expect(later).toEqual([]);

  const other = res.conflicts(store.state, { ...fall, event: "Cubs", items: [f.t2], generics: [] });
  expect(other).toEqual([]);
});

test("a generic conflicts when demand across the dates exceeds its units (FR-RES-15)", async () => {
  const f = await fixture();
  // Fall Camp names one tent and wants one more of the generic: two of three.
  await res.createReservation(store, { ...fall, items: [f.t1], generics: [{ item_id: f.tents, quantity: 1 }] });

  const one = res.conflicts(store.state, {
    ...fall,
    event: "Cubs",
    items: [],
    generics: [{ item_id: f.tents, quantity: 1 }],
  });
  expect(one).toEqual([]);

  const two = res.conflicts(store.state, {
    ...fall,
    event: "Cubs",
    items: [],
    generics: [{ item_id: f.tents, quantity: 2 }],
  });
  expect(two).toEqual([{ id: expect.any(String), event: "Fall Camp", detail: "4 × 4-person tent, we have 3" }]);

  // Retired gear does not count as owned.
  await act.retireItem(store, f.t3);
  expect(
    res.conflicts(store.state, { ...fall, event: "Cubs", items: [], generics: [{ item_id: f.tents, quantity: 1 }] }),
  ).toHaveLength(1);
});

test("editing a reservation does not conflict with itself", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, {
    ...fall,
    items: [f.t1],
    generics: [{ item_id: f.tents, quantity: 2 }],
  });
  expect(
    res.conflicts(store.state, { ...fall, items: [f.t1, f.t2], generics: [{ item_id: f.tents, quantity: 1 }] }, id),
  ).toEqual([]);
  expect(res.conflicts(store.state, { ...fall, items: [f.t1], generics: [] })).toHaveLength(1);
});

test("remaining is what is not yet out under the event, by home; a generic ticks off on any unit", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, {
    ...fall,
    items: [f.stove, f.t1, f.tarp],
    generics: [{ item_id: f.tents, quantity: 2 }],
  });
  const r = res.reservation(store.state, id)!;

  let rem = res.remaining(store.state, r);
  expect(rem.items.map(shown)).toEqual(["4-person tent #1", "Stove", "Tarp"]);
  expect(rem.generics).toEqual([{ generic: expect.objectContaining({ name: "4-person tent" }), quantity: 2, done: 0 }]);
  expect(res.isPacked(rem)).toBe(false);

  await mv.checkOut(store, f.t1, { event: "Fall Camp" });
  await mv.checkOut(store, f.t2, { event: "Fall Camp" });
  await mv.checkOut(store, f.stove, { event: "Other trip" }); // out, but not for us
  rem = res.remaining(store.state, r);
  expect(rem.items.map(shown)).toEqual(["Stove", "Tarp"]);
  // #1 is named, so it is its own line; only #2 counts toward the generic.
  expect(rem.generics[0]!.done).toBe(1);

  await mv.checkIn(store, f.stove);
  await mv.checkOut(store, f.stove, { event: "Fall Camp" });
  await mv.checkOut(store, f.tarp, { event: "Fall Camp" });
  await mv.checkOut(store, f.t3, { event: "Fall Camp" });
  rem = res.remaining(store.state, r);
  expect(rem.items).toEqual([]);
  expect(rem.generics[0]!.done).toBe(2);
  expect(res.isPacked(rem)).toBe(true);
});

test("an update records one field_changed per changed field, and the gear list one event per line", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, {
    ...fall,
    items: [f.t1, f.stove],
    generics: [{ item_id: f.tents, quantity: 2 }],
  });
  await res.updateReservation(store, id, {
    items: [f.t1, f.t2],
    event: "Fall Camp",
    ends: "2026-10-05",
    generics: [{ item_id: f.tents, quantity: 3 }],
  });

  expect(store.pending.filter((e) => e.type === "field_changed").map((e) => e.payload)).toEqual([
    { field: "ends", value: "2026-10-05", old: "2026-10-04" },
  ]);
  expect(
    store.pending
      .filter((e) => e.entity_id === id && e.type !== "created" && e.type !== "field_changed")
      .map((e) => [e.type, e.payload]),
  ).toEqual([
    ["item_removed", { item_id: f.stove }],
    ["item_added", { item_id: f.t2 }],
    ["quantity_changed", { item_id: f.tents, quantity: 3 }],
  ]);
  expect(res.reservation(store.state, id)).toMatchObject({
    items: [f.t1, f.t2],
    ends: "2026-10-05",
    generics: [{ item_id: f.tents, quantity: 3 }],
  });
});

test("two phones each add a different extra offline and both survive (FR-RES-07)", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, { ...fall, items: [f.t1], generics: [] });
  // The other phone's event, as it arrives in a sync: recorded there, never seen here.
  const theirs: ServerEvent = {
    id: "01000000000000000000000009",
    entity_type: "reservation",
    entity_id: id,
    type: "item_added",
    actor_id: "bob",
    device_id: "other-phone",
    device_seq: 1,
    occurred_at: 900_000,
    clock_offset: 0,
    effective_at: 900_000,
    received_at: 900_000,
    seq: 1,
    payload: { item_id: f.tarp },
  };
  await res.addItem(store, id, f.stove);
  await store.receive([theirs], 1);
  expect(res.reservation(store.state, id)?.items).toEqual([f.t1, f.stove, f.tarp]);
});

test("removing a generic line is a quantity of zero", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: f.tents, quantity: 2 }] });
  await res.setQuantity(store, id, f.tents, 0);
  expect(res.reservation(store.state, id)?.generics).toEqual([]);
});

test("an extra scanned in the session joins the list; a full generic line rises by one (FR-RES-07)", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, {
    ...fall,
    items: [f.stove],
    generics: [{ item_id: f.tents, quantity: 1 }],
  });

  // A single item nobody listed joins by name.
  await mv.checkOut(store, f.tarp, { event: fall.event });
  await res.addExtra(store, id, f.tarp);
  expect(res.reservation(store.state, id)?.items).toEqual([f.stove, f.tarp]);

  // The first tent fills the line that was asked for; the list does not grow.
  await mv.checkOut(store, f.t1, { event: fall.event });
  await res.addExtra(store, id, f.t1);
  expect(res.reservation(store.state, id)?.items).toEqual([f.stove, f.tarp]);
  expect(res.reservation(store.state, id)?.generics).toEqual([{ item_id: f.tents, quantity: 1 }]);

  // The second overflows it, so the line rises instead of naming the unit.
  await mv.checkOut(store, f.t2, { event: fall.event });
  await res.addExtra(store, id, f.t2);
  expect(res.reservation(store.state, id)?.items).toEqual([f.stove, f.tarp]);
  expect(res.reservation(store.state, id)?.generics).toEqual([{ item_id: f.tents, quantity: 2 }]);

  const r = res.reservation(store.state, id)!;
  expect(res.remaining(store.state, r).items.map(shown)).toEqual(["Stove"]);
  expect(res.remaining(store.state, r).packed.map(shown)).toEqual(["Tarp"]);
  expect(res.remaining(store.state, r).generics[0]).toMatchObject({ quantity: 2, done: 2 });
});

test("gear that left before the plan did is linked, not moved (FR-RES-17, S-RES-07)", async () => {
  const f = await fixture();
  // Thursday: three tents out with no event set.
  await mv.checkOut(store, f.t1);
  await mv.checkOut(store, f.t2);
  await mv.checkOut(store, f.stove, { event: "Somebody else's trip" });
  const id = await res.createReservation(store, {
    ...fall,
    items: [f.t1, f.stove],
    generics: [{ item_id: f.tents, quantity: 1 }],
  });

  // A named item that is out under nothing: one tap.
  const before = inv.item(store.state, f.t1)!.movement;
  await res.linkOut(store, id, f.t1);
  const after = inv.item(store.state, f.t1)!;
  expect(after.movement).toMatchObject({ id: before?.id, type: "checked_out", event: "Fall Camp" });
  expect(after.status).toBe("out");
  expect(store.pending.at(-1)).toMatchObject({
    type: "event_corrected",
    entity_id: f.t1,
    payload: { movement_id: before?.id, event: "Fall Camp" },
  });

  // One out under another event, and not on the list: it is linked and joins it.
  expect(res.outElsewhere(store.state, res.reservation(store.state, id)!).map(shown)).toEqual(["4-person tent #2"]);
  await res.linkOut(store, id, f.t2);
  expect(inv.item(store.state, f.t2)!.movement).toMatchObject({ event: "Fall Camp" });
  // #2 fills the generic line rather than joining by name.
  expect(res.reservation(store.state, id)?.items).toEqual([f.t1, f.stove]);
  expect(res.remaining(store.state, res.reservation(store.state, id)!).generics[0]).toMatchObject({ done: 1 });

  // The stove was named and out elsewhere; linking corrects its event too.
  await res.linkOut(store, id, f.stove);
  expect(inv.item(store.state, f.stove)!.movement).toMatchObject({ event: "Fall Camp" });
  expect(res.isPacked(res.remaining(store.state, res.reservation(store.state, id)!))).toBe(true);
  // Nothing was checked out or in for the linking.
  expect(store.pending.filter((e) => e.type === "checked_out")).toHaveLength(3);
  expect(store.pending.filter((e) => e.type === "checked_in")).toHaveLength(0);
});

test("the history shows a corrected event, and the original check-out stands (FR-OUT-16)", async () => {
  const f = await fixture();
  const out = await mv.checkOut(store, f.t1, { event: "Thursday" });
  await mv.correctEvent(store, f.t1, out.id, "Fall Camp");
  expect(mv.history(store, f.t1).map((h) => [h.id, h.event])).toEqual([[out.id, "Fall Camp"]]);
  expect(store.pending.find((e) => e.id === out.id)?.payload).toEqual({ holder_id: "alice", event: "Thursday" });
});

test("a reservation naming a merged duplicate packs the survivor (FR-INV-13)", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, { ...fall, items: [f.t1, f.t2], generics: [] });
  await act.mergeItem(store, f.t1, f.t2);
  const booked = res.reservation(store.state, id)!;
  expect(res.remaining(store.state, booked).items.map(shown)).toEqual(["4-person tent #2"]);
  await mv.checkOut(store, f.t2, { event: fall.event });
  expect(res.isPacked(res.remaining(store.state, booked))).toBe(true);
  // Another camp naming the duplicate clashes on the survivor.
  const other = { ...fall, items: [f.t1], generics: [] };
  expect(res.conflicts(store.state, other).map((c) => c.detail)).toEqual(["4-person tent #2"]);
});
