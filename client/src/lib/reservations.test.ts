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

test("a draft that only names a unit is still checked against the generic's stock (FR-RES-15)", async () => {
  const f = await fixture();
  // Fall Camp reserves all three tents by count.
  await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: f.tents, quantity: 3 }] });

  // A draft that only names one tent unit, never mentioning generics, must still be caught.
  const named = res.conflicts(store.state, { ...fall, event: "Cubs", items: [f.t1], generics: [] });
  expect(named).toEqual([{ id: expect.any(String), event: "Fall Camp", detail: "4 × 4-person tent, we have 3" }]);
});

test("a pool conflicts against what it owns, not a count of units it does not have (FR-RES-15)", async () => {
  await store.record({
    entity_type: "item",
    entity_id: "bowls",
    type: "created",
    actor_id: "alice",
    payload: { name: "Bowls", generic: true, pool: true, quantity: 10 },
  });
  await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: "bowls", quantity: 6 }] });

  const fits = res.conflicts(store.state, {
    ...fall,
    event: "Cubs",
    items: [],
    generics: [{ item_id: "bowls", quantity: 4 }],
  });
  expect(fits).toEqual([]);

  const tooMany = res.conflicts(store.state, {
    ...fall,
    event: "Cubs",
    items: [],
    generics: [{ item_id: "bowls", quantity: 5 }],
  });
  expect(tooMany).toEqual([{ id: expect.any(String), event: "Fall Camp", detail: "11 × Bowls, we have 10" }]);
});

test("remaining ticks off a pool line from what its latest check-out for the event carried (FR-RES-13)", async () => {
  await store.record({
    entity_type: "item",
    entity_id: "bowls",
    type: "created",
    actor_id: "alice",
    payload: { name: "Bowls", generic: true, pool: true, quantity: 10 },
  });
  const id = await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: "bowls", quantity: 4 }] });

  let r = res.reservation(store.state, id)!;
  expect(res.remaining(store.state, r).generics[0]).toMatchObject({ quantity: 4, done: 0 });
  expect(res.isPacked(res.remaining(store.state, r))).toBe(false);

  await res.checkOutPoolLine(store, r, "bowls", 4);
  r = res.reservation(store.state, id)!;
  expect(res.remaining(store.state, r).generics[0]).toMatchObject({ quantity: 4, done: 4 });
  expect(res.isPacked(res.remaining(store.state, r))).toBe(true);
  expect(inv.poolCounts(inv.item(store.state, "bowls")!)).toMatchObject({
    owned: 10,
    in: 6,
    out: [{ holder_id: "alice", count: 4 }],
  });
});

test("remaining adds a second check-out under the same event, it does not replace the first (FR-RES-13)", async () => {
  await store.record({
    entity_type: "item",
    entity_id: "bowls",
    type: "created",
    actor_id: "alice",
    payload: { name: "Bowls", generic: true, pool: true, quantity: 10 },
  });
  const id = await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: "bowls", quantity: 5 }] });
  let r = res.reservation(store.state, id)!;

  await res.checkOutPoolLine(store, r, "bowls", 2);
  r = res.reservation(store.state, id)!;
  expect(res.remaining(store.state, r).generics[0]).toMatchObject({ quantity: 5, done: 2 });

  await res.checkOutPoolLine(store, r, "bowls", 2);
  r = res.reservation(store.state, id)!;
  expect(res.remaining(store.state, r).generics[0]).toMatchObject({ quantity: 5, done: 4 });
  expect(res.isPacked(res.remaining(store.state, r))).toBe(false);
});

test("pool progress is by reservation, not event name: a repeat camp starts at zero (FR-RES-13)", async () => {
  await store.record({
    entity_type: "item",
    entity_id: "bowls",
    type: "created",
    actor_id: "alice",
    payload: { name: "Bowls", generic: true, pool: true, quantity: 10 },
  });
  const lastYear = await res.createReservation(store, {
    ...fall,
    starts: "2025-10-02",
    ends: "2025-10-04",
    items: [],
    generics: [{ item_id: "bowls", quantity: 4 }],
  });
  const thisYear = await res.createReservation(store, {
    ...fall,
    items: [],
    generics: [{ item_id: "bowls", quantity: 4 }],
  });

  await res.checkOutPoolLine(store, res.reservation(store.state, lastYear)!, "bowls", 4);
  expect(res.remaining(store.state, res.reservation(store.state, lastYear)!).generics[0]).toMatchObject({ done: 4 });
  expect(res.remaining(store.state, res.reservation(store.state, thisYear)!).generics[0]).toMatchObject({ done: 0 });
});

test("a retired pool cannot be checked out for a reservation (FR-INV-04)", async () => {
  await store.record({
    entity_type: "item",
    entity_id: "bowls",
    type: "created",
    actor_id: "alice",
    payload: { name: "Bowls", generic: true, pool: true, quantity: 10 },
  });
  const id = await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: "bowls", quantity: 4 }] });
  const r = res.reservation(store.state, id)!;
  await act.retireItem(store, "bowls");

  await expect(res.checkOutPoolLine(store, r, "bowls", 4)).rejects.toThrow("retired items cannot be checked out");
});

test("nearby names a camp within seven days sharing a unit, not one overlapping (FR-RES-19)", async () => {
  const f = await fixture();
  await res.createReservation(store, { ...fall, items: [f.t1], generics: [] });

  // Four days after Fall Camp ends: near, not overlapping.
  const near = res.nearby(store.state, {
    event: "Winter Prep",
    starts: "2026-10-08",
    ends: "2026-10-09",
    items: [f.t1],
    generics: [],
  });
  expect(near[f.t1]).toEqual([{ event: "Fall Camp", detail: "2026-10-02 – 2026-10-04" }]);

  // Eight days after Fall Camp ends: outside the window.
  const far = res.nearby(store.state, {
    event: "Spring",
    starts: "2026-10-13",
    ends: "2026-10-14",
    items: [f.t1],
    generics: [],
  });
  expect(far).toEqual({});

  // Overlapping is a conflict, not a near clash.
  const overlap = res.nearby(store.state, { ...fall, event: "Same time", items: [f.t1], generics: [] });
  expect(overlap).toEqual({});
});

test("nearby marks a generic only when the near camps would leave us short, not just for sharing a line (FR-RES-19, FR-RES-15)", async () => {
  const f = await fixture();
  // Fall Camp takes 2 of the 3 tents.
  await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: f.tents, quantity: 2 }] });

  // Four days later, Winter Prep wants 1 more: 3 needed, 3 owned. Enough to go around.
  const fits = res.nearby(store.state, {
    event: "Winter Prep",
    starts: "2026-10-08",
    ends: "2026-10-09",
    items: [],
    generics: [{ item_id: f.tents, quantity: 1 }],
  });
  expect(fits).toEqual({});

  // Winter Prep wants 2 more: 4 needed, only 3 owned. Now it is worth a warning.
  const short = res.nearby(store.state, {
    event: "Winter Prep",
    starts: "2026-10-08",
    ends: "2026-10-09",
    items: [],
    generics: [{ item_id: f.tents, quantity: 2 }],
  });
  expect(short[f.tents]).toEqual([{ event: "Fall Camp", detail: "2026-10-02 – 2026-10-04" }]);
});

test("nearby weighs each near camp against the draft alone, not against each other (FR-RES-19)", async () => {
  const f = await fixture();
  const before = { event: "Cub Camp", starts: "2026-09-26", ends: "2026-09-27" };
  const after = { event: "Winter Prep", starts: "2026-10-09", ends: "2026-10-10" };
  await res.createReservation(store, { ...before, items: [], generics: [{ item_id: f.tents, quantity: 2 }] });
  await res.createReservation(store, { ...after, items: [], generics: [{ item_id: f.tents, quantity: 2 }] });

  // One more tent between them: 3 of 3 with either neighbour. The neighbours are a fortnight
  // apart and never share tents with each other, so they are not added together.
  expect(res.nearby(store.state, { ...fall, items: [], generics: [{ item_id: f.tents, quantity: 1 }] })).toEqual({});

  // Two more is short against each of them.
  const short = res.nearby(store.state, { ...fall, items: [], generics: [{ item_id: f.tents, quantity: 2 }] });
  expect(short[f.tents]?.map((n) => n.event)).toEqual(["Cub Camp", "Winter Prep"]);
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

test("remaining is what is not yet out under the reservation, by home; a generic ticks off on any unit", async () => {
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

  await mv.checkOut(store, f.t1, { event: "Fall Camp", reservation_id: id });
  await mv.checkOut(store, f.t2, { event: "Fall Camp", reservation_id: id });
  await mv.checkOut(store, f.stove, { event: "Other trip" }); // out, but not for us
  rem = res.remaining(store.state, r);
  expect(rem.items.map(shown)).toEqual(["Stove", "Tarp"]);
  // #1 is named, so it is its own line; only #2 counts toward the generic.
  expect(rem.generics[0]!.done).toBe(1);

  await mv.checkIn(store, f.stove);
  await mv.checkOut(store, f.stove, { event: "Fall Camp", reservation_id: id });
  await mv.checkOut(store, f.tarp, { event: "Fall Camp", reservation_id: id });
  await mv.checkOut(store, f.t3, { event: "Fall Camp", reservation_id: id });
  rem = res.remaining(store.state, r);
  expect(rem.items).toEqual([]);
  expect(rem.generics[0]!.done).toBe(2);
  expect(res.isPacked(rem)).toBe(true);
});

test("a repeat camp under the same event name does not read as packed (FR-RES-13)", async () => {
  const f = await fixture();
  const lastYear = await res.createReservation(store, {
    ...fall,
    starts: "2025-10-02",
    ends: "2025-10-04",
    items: [f.t1],
    generics: [],
  });
  const thisYear = await res.createReservation(store, { ...fall, items: [f.t1], generics: [] });

  await mv.checkOut(store, f.t1, { event: fall.event, reservation_id: lastYear });
  expect(res.isPacked(res.remaining(store.state, res.reservation(store.state, lastYear)!))).toBe(true);
  // Same event name, a different reservation: the check-out above must not count here.
  expect(res.isPacked(res.remaining(store.state, res.reservation(store.state, thisYear)!))).toBe(false);
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

test("two devices each add a different extra offline and both survive (FR-RES-07)", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, { ...fall, items: [f.t1], generics: [] });
  // The other device's event, as it arrives in a sync: recorded there, never seen here.
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
  await mv.checkOut(store, f.tarp, { event: fall.event, reservation_id: id });
  await res.addExtra(store, id, f.tarp);
  expect(res.reservation(store.state, id)?.items).toEqual([f.stove, f.tarp]);

  // The first tent fills the line that was asked for; the list does not grow.
  await mv.checkOut(store, f.t1, { event: fall.event, reservation_id: id });
  await res.addExtra(store, id, f.t1);
  expect(res.reservation(store.state, id)?.items).toEqual([f.stove, f.tarp]);
  expect(res.reservation(store.state, id)?.generics).toEqual([{ item_id: f.tents, quantity: 1 }]);

  // The second overflows it, so the line rises instead of naming the unit.
  await mv.checkOut(store, f.t2, { event: fall.event, reservation_id: id });
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
  expect(after.movement).toMatchObject({ id: before?.id, type: "checked_out", event: "Fall Camp", reservation_id: id });
  expect(after.status).toBe("out");
  expect(store.pending.at(-1)).toMatchObject({
    type: "event_corrected",
    entity_id: f.t1,
    payload: { movement_id: before?.id, event: "Fall Camp", reservation_id: id },
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
  expect(store.pending.find((e) => e.id === out.id)?.payload).toEqual({
    holder_id: "alice",
    event: "Thursday",
    reservation_id: null,
  });
});

test("a reservation naming a merged duplicate packs the survivor (FR-INV-13)", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, { ...fall, items: [f.t1, f.t2], generics: [] });
  await act.mergeItem(store, f.t1, f.t2);
  const booked = res.reservation(store.state, id)!;
  expect(res.remaining(store.state, booked).items.map(shown)).toEqual(["4-person tent #2"]);
  await mv.checkOut(store, f.t2, { event: fall.event, reservation_id: id });
  expect(res.isPacked(res.remaining(store.state, booked))).toBe(true);
  // Another camp naming the duplicate clashes on the survivor.
  const other = { ...fall, items: [f.t1], generics: [] };
  expect(res.conflicts(store.state, other).map((c) => c.detail)).toEqual(["4-person tent #2"]);
});

test("remaining does not count a retired unit as packed", async () => {
  const f = await fixture();
  const id = await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: f.tents, quantity: 2 }] });
  await mv.checkOut(store, f.t1, { event: fall.event, reservation_id: id });
  await mv.checkOut(store, f.t2, { event: fall.event, reservation_id: id });
  await act.retireItem(store, f.t2);
  const r = res.reservation(store.state, id)!;
  expect(res.remaining(store.state, r).generics[0]).toMatchObject({ quantity: 2, done: 1 });
});
