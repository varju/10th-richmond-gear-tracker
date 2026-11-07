import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import type { ServerEvent } from "./api";
import * as inv from "./inventory";
import { openDb } from "./db";
import * as mv from "./movement";
import * as res from "./reservations";
import { Store } from "./store";
import { checkOutUnplanned } from "./unplannedTestKit";

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
  await checkOutUnplanned(store, f.stove, "Other trip"); // out, but not for us
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
  await checkOutUnplanned(store, f.stove, "Somebody else's trip");
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
  const out = await checkOutUnplanned(store, f.t1, "Thursday");
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

const rows = (now = clock) =>
  res.unplanned(store, now).map((u) => [u.event, u.starts, u.ends, u.items.map(shown)] as const);

const calendar = (starts: string, ends: string) =>
  store.setMeta({ calendar_events: [{ uid: "a", summary: "Apple day", starts, ends, all_day: true }] });

test("gear out under an event with no reservation is offered, one row per event (FR-RES-28)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 9, 18); // 2026-10-09 in Vancouver
  await checkOutUnplanned(store, f.t1, "Apple Day");
  clock = Date.UTC(2026, 9, 10, 18);
  await checkOutUnplanned(store, f.stove, "  apple   day ");
  await checkOutUnplanned(store, f.tarp, "Fall Camp");
  await mv.checkOut(store, f.t2); // no event: nothing to name a reservation after
  const now = Date.UTC(2026, 9, 12, 18);

  // Last year's camp of the same name ended long before this gear went out, so it does not count.
  await res.createReservation(store, { ...fall, starts: "2025-10-02", ends: "2025-10-04", items: [], generics: [] });
  expect(rows(now)).toEqual([
    // The spelling of the first check-out; first check-out to today.
    ["Apple Day", "2026-10-09", "2026-10-12", ["4-person tent #1", "Stove"]],
    ["Fall Camp", "2026-10-10", "2026-10-12", ["Tarp"]],
  ]);

  // A reservation of that name over the day the gear went out, or up to seven days after it, takes it off the list.
  await res.createReservation(store, { ...fall, starts: "2026-10-18", ends: "2026-10-20", items: [], generics: [] });
  expect(rows(now).map((r) => r[0])).toEqual(["Apple Day", "Fall Camp"]);
  await res.createReservation(store, { ...fall, starts: "2026-10-17", ends: "2026-10-20", items: [], generics: [] });
  expect(rows(now).map((r) => r[0])).toEqual(["Apple Day"]);
});

test("a calendar event of that name gives the dates if it covers the first day out or starts within a week of it (FR-RES-32)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 9, 18);
  await checkOutUnplanned(store, f.t1, "Apple Day");
  const now = Date.UTC(2026, 9, 12, 18);

  await calendar("2026-10-08", "2026-10-13");
  expect(rows(now)[0]!).toEqual(["Apple day", "2026-10-08", "2026-10-13", ["4-person tent #1"]]);
  // Never ends before today: the gear is still out.
  await calendar("2026-10-09", "2026-10-10");
  expect(rows(now)[0]!.slice(1, 3)).toEqual(["2026-10-09", "2026-10-12"]);
  // Picked up early for it.
  await calendar("2026-10-15", "2026-10-16");
  expect(rows(now)[0]!.slice(1, 3)).toEqual(["2026-10-15", "2026-10-16"]);
  await calendar("2026-10-17", "2026-10-18");
  expect(rows(now)[0]!.slice(0, 3)).toEqual(["Apple Day", "2026-10-09", "2026-10-12"]);
});

test("gear still out from last year under the same name is its own row (FR-RES-28)", async () => {
  const f = await fixture();
  clock = Date.UTC(2025, 9, 3, 18);
  await checkOutUnplanned(store, f.t1, "Fall Camp");
  clock = Date.UTC(2025, 9, 10, 18); // seven days on: the same trip
  await checkOutUnplanned(store, f.t2, "Fall Camp");
  clock = Date.UTC(2026, 9, 10, 18);
  await checkOutUnplanned(store, f.tarp, "Fall Camp");

  expect(rows(Date.UTC(2026, 9, 12, 18))).toEqual([
    ["Fall Camp", "2025-10-03", "2026-10-12", ["4-person tent #1", "4-person tent #2"]],
    ["Fall Camp", "2026-10-10", "2026-10-12", ["Tarp"]],
  ]);
});

test("a transfer does not move the day the gear went out (FR-RES-28)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 1, 18);
  await checkOutUnplanned(store, f.t1, "Apple Day");
  clock = Date.UTC(2026, 9, 10, 18);
  const first = inv.item(store.state, f.t1)!.movement!;
  await store.record({
    entity_type: "item",
    entity_id: f.t1,
    type: "checked_out",
    actor_id: "alice",
    payload: { holder_id: "bob", event: "Apple Day", reservation_id: null, supersedes: first.id },
  });
  expect(rows()[0]!.slice(1, 2)).toEqual(["2026-10-01"]);

  // Back in and out again starts a new time out.
  await mv.checkIn(store, f.t1);
  clock = Date.UTC(2026, 9, 11, 18);
  await checkOutUnplanned(store, f.t1, "Apple Day");
  expect(rows()[0]!.slice(1, 2)).toEqual(["2026-10-11"]);
});

test("gear and counts packing a reservation are not offered (FR-RES-28)", async () => {
  const f = await fixture();
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  const camp = await res.createReservation(store, { ...fall, items: [f.t1], generics: [] });
  await mv.checkOut(store, f.t1, { event: "Fall Camp", reservation_id: camp });
  await res.cancelReservation(store, camp);
  await mv.checkOut(store, f.stove, { event: "Cub camp", reservation_id: camp });
  const other = await res.createReservation(store, { ...fall, event: "Hike", items: [f.tarp], generics: [] });
  await mv.checkOut(store, f.tarp, { event: "Somewhere", reservation_id: other });
  await res.checkOutPoolLine(store, { ...fall, id: other, items: [], generics: [] }, bowls, 3);

  // A cancelled reservation packs nothing, so its gear is offered under its event.
  expect(rows().map((r) => [r[0], r[3]])).toEqual([
    ["Cub camp", ["Stove"]],
    ["Fall Camp", ["4-person tent #1"]],
  ]);
});

test("one tap makes the reservation and links each item to it, moving nothing (FR-RES-31)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 10, 18);
  const out = await checkOutUnplanned(store, f.t1, "Apple Day");
  await checkOutUnplanned(store, f.stove, "apple day");
  const before = store.pending.length;

  const now = Date.UTC(2026, 9, 11, 18);
  const key = res.unplanned(store, now)[0]!.key;
  const made = await res.reserveFromEvent(store, key, now);
  if (made.kind !== "made") throw new Error("not made");
  expect(made.unlinked).toEqual([]);
  expect(res.reservation(store.state, made.id)).toMatchObject({
    event: "Apple Day",
    starts: "2026-10-10",
    ends: "2026-10-11",
    items: [f.t1, f.stove],
    generics: [],
  });
  expect(store.pending.slice(before).map((e) => [e.type, e.entity_id])).toEqual([
    ["created", made.id],
    ["event_corrected", f.t1],
    ["event_corrected", f.stove],
  ]);
  expect(store.pending.find((e) => e.type === "event_corrected" && e.entity_id === f.t1)?.payload).toEqual({
    movement_id: out.id,
    event: "Apple Day",
    reservation_id: made.id,
  });
  expect(res.isPacked(res.remaining(store.state, res.reservation(store.state, made.id)!))).toBe(true);
  expect(res.unplanned(store, now)).toEqual([]);
  expect(await res.reserveFromEvent(store, key, now)).toEqual({ kind: "gone" });
});

test("an item that fails to link stays on the new reservation, unpacked, and is named (FR-RES-31)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 10, 18);
  await checkOutUnplanned(store, f.t1, "Apple Day");
  await checkOutUnplanned(store, f.stove, "Apple Day");

  // Returned on another tap while the reservation was being made.
  const making = res.reserveFromEvent(store, res.unplanned(store, clock)[0]!.key, clock);
  await mv.checkIn(store, f.stove);
  const made = await making;
  if (made.kind !== "made") throw new Error("not made");
  expect(made.unlinked).toEqual([f.stove]);
  // One linked, so the page names the rest rather than giving a reason.
  expect(made.error).toBeUndefined();
  const r = res.reservation(store.state, made.id)!;
  expect(r.items).toEqual([f.t1, f.stove]);
  expect(res.remaining(store.state, r).items.map(shown)).toEqual(["Stove"]);
});

test("when nothing links, the first reason comes back (FR-RES-31)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 10, 18);
  await checkOutUnplanned(store, f.t1, "Apple Day");
  await checkOutUnplanned(store, f.stove, "Apple Day");
  const making = res.reserveFromEvent(store, res.unplanned(store, clock)[0]!.key, clock);
  // Signed out once the reservation was recorded, before any link.
  delete store.meta.user;
  expect(await making).toMatchObject({ kind: "made", unlinked: [f.t1, f.stove], error: "not signed in" });
});

test("a counted stack out under an unplanned event is listed with its count (FR-RES-28)", async () => {
  await fixture();
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  await checkOutUnplanned(store, bowls, "Cub camp", 4);

  const rows = res.unplanned(store, clock);
  expect(rows.map((r) => [r.event, r.items, r.pools.map((p) => [p.item.id, p.count])])).toEqual([
    ["Cub camp", [], [[bowls, 4]]],
  ]);
});

test("one tap brings a counted stack in as a quantity line, already packed (FR-RES-31)", async () => {
  await fixture();
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  await checkOutUnplanned(store, bowls, "Cub camp", 4);

  const made = await res.reserveFromEvent(store, res.unplanned(store, clock)[0]!.key, clock);
  if (made.kind !== "made") throw new Error("not made");

  const r = res.reservation(store.state, made.id)!;
  expect(r.generics).toEqual([{ item_id: bowls, quantity: 4 }]);
  expect(res.remaining(store.state, r).generics.map((g) => g.done)).toEqual([4]);
  expect(res.unplanned(store, clock)).toEqual([]);
});

test("It's with us takes only a pool's counts under the event's own name (FR-RES-17)", async () => {
  await fixture();
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  await checkOutUnplanned(store, bowls, "Fall Camp", 4);
  await checkOutUnplanned(store, bowls, "Meeting", 2);
  const id = await res.createReservation(store, { ...fall, items: [], generics: [] });
  const r = res.reservation(store.state, id)!;
  expect(res.outElsewhere(store.state, r).map((it) => it.id)).toEqual([bowls]);

  await res.linkOut(store, id, bowls);

  const after = res.reservation(store.state, id)!;
  expect(after.generics).toEqual([{ item_id: bowls, quantity: 4 }]);
  expect(res.outElsewhere(store.state, after)).toEqual([]);
  await expect(res.linkOut(store, id, bowls)).rejects.toThrow("it is not out");
});

test("Add links only its own row's counts, leaving last year's row as it was (FR-RES-33)", async () => {
  await fixture();
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  clock = Date.UTC(2025, 9, 10, 18);
  await checkOutUnplanned(store, bowls, "Fall Camp", 3);
  clock = Date.UTC(2026, 9, 10, 18);
  await checkOutUnplanned(store, bowls, "Fall Camp", 4);

  const rows = res.unplanned(store, clock);
  expect(rows.map((r) => r.pools.map((p) => p.count))).toEqual([[3], [4]]);
  const made = await res.reserveFromEvent(store, rows[1]!.key, clock);
  if (made.kind !== "made") throw new Error("not made");

  expect(res.reservation(store.state, made.id)?.generics).toEqual([{ item_id: bowls, quantity: 4 }]);
  expect(res.unplanned(store, clock).map((r) => r.pools.map((p) => p.count))).toEqual([[3]]);
});

test("It's with us leaves counts packing another live event, and takes a cancelled one's (FR-RES-17)", async () => {
  await fixture();
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  const old = await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: bowls, quantity: 3 }] });
  await res.checkOutPoolLine(store, res.reservation(store.state, old)!, bowls, 3);
  const id = await res.createReservation(store, { ...fall, items: [], generics: [] });

  expect(res.unlinkedLots(store.state, res.reservation(store.state, id)!, bowls)).toEqual([]);
  await res.cancelReservation(store, old);
  expect(res.unlinkedLots(store.state, res.reservation(store.state, id)!, bowls).map((l) => l.count)).toEqual([3]);
});

test("a check-out under a planned event's name links to it and joins its list (FR-OUT-45)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 1, 18);
  const id = await res.createReservation(store, { ...fall, items: [f.stove], generics: [] });

  await mv.checkOut(store, f.tarp, { event: "fall camp" });
  expect(inv.item(store.state, f.tarp)!.movement).toMatchObject({ event: "fall camp", reservation_id: id });
  expect(res.reservation(store.state, id)?.items).toEqual([f.stove, f.tarp]);

  // More than a week before it starts, the name alone does not link it: a reservation is made for today.
  clock = Date.UTC(2026, 8, 20, 18);
  await mv.checkOut(store, f.t1, { event: "Fall Camp" });
  const other = inv.item(store.state, f.t1)!.movement!.reservation_id as string;
  expect(other).not.toBe(id);
  expect(res.reservation(store.state, other)).toMatchObject({ starts: "2026-09-20", ends: "2026-09-20" });
});

const made = (event: string) => res.reservations(store.state).filter((r) => r.event === event);

test("a check-out under a new event name makes a reservation for today, once (FR-RES-38)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 3, 18);
  await mv.checkOut(store, f.tarp, { event: "  Fall   Camp " });
  await mv.checkOut(store, f.stove, { event: "fall camp" });
  const [r, ...rest] = made("Fall Camp");
  expect(rest).toEqual([]);
  expect(r).toMatchObject({ starts: "2026-10-03", ends: "2026-10-03", items: [f.tarp, f.stove] });
  expect(inv.item(store.state, f.tarp)!.movement).toMatchObject({ reservation_id: r!.id });
});

test("a stack checked out under a new event name makes a reservation with its count (FR-RES-38)", async () => {
  clock = Date.UTC(2026, 9, 3, 18);
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  await mv.checkOutPool(store, bowls, { count: 3, event: "Fall Camp" });
  expect(made("Fall Camp")[0]!.generics).toEqual([{ item_id: bowls, quantity: 3 }]);
});

test("a check-out under an ended event's name, with its gear still out, moves its end date out (FR-RES-39)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 3, 18);
  await mv.checkOut(store, f.tarp, { event: "Fall Camp" });
  const id = made("Fall Camp")[0]!.id;

  clock = Date.UTC(2026, 9, 6, 18);
  await mv.checkOut(store, f.stove, { event: "Fall Camp" });
  expect(made("Fall Camp")).toHaveLength(1);
  expect(res.reservation(store.state, id)).toMatchObject({
    starts: "2026-10-03",
    ends: "2026-10-06",
    items: [f.tarp, f.stove],
  });

  // Nothing of it is out any more: the name starts a new one.
  await mv.checkIn(store, f.tarp);
  await mv.checkIn(store, f.stove);
  clock = Date.UTC(2026, 9, 20, 18);
  await mv.checkOut(store, f.t1, { event: "Fall Camp" });
  expect(inv.item(store.state, f.t1)!.movement!.reservation_id).not.toBe(id);
  expect(res.reservation(store.state, id)!.ends).toBe("2026-10-06");
});

test("a stray tent from last year does not keep an old event open (FR-RES-39)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 3, 18);
  await mv.checkOut(store, f.tarp, { event: "Fall Camp" });
  const old = made("Fall Camp")[0]!.id;

  clock = Date.UTC(2027, 9, 5, 18);
  await mv.checkOut(store, f.t1, { event: "Fall Camp" });
  expect(made("Fall Camp")).toHaveLength(2);
  expect(inv.item(store.state, f.t1)!.movement!.reservation_id).not.toBe(old);
  expect(res.reservation(store.state, old)!.ends).toBe("2026-10-03");
});

test("the latest ended event of that name with gear out wins (FR-RES-39)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 1, 18);
  await mv.checkOut(store, f.tarp, { event: "Fall Camp" });
  clock = Date.UTC(2026, 9, 9, 18);
  await mv.checkOut(store, f.stove, { event: "Fall Camp" });
  const [older, newer] = made("Fall Camp").sort((a, b) => a.ends.localeCompare(b.ends));
  expect(older!.ends).toBe("2026-10-01");

  clock = Date.UTC(2026, 9, 12, 18);
  await mv.checkOut(store, f.t1, { event: "Fall Camp" });
  expect(inv.item(store.state, f.t1)!.movement!.reservation_id).toBe(newer!.id);
  expect(res.reservation(store.state, newer!.id)!.ends).toBe("2026-10-12");
});

test("the end date stays put when moving it out would clash with another event, but the gear still joins (FR-RES-39)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 3, 18);
  await mv.checkOut(store, f.tarp, { event: "Fall Camp" });
  const id = made("Fall Camp")[0]!.id;
  await res.createReservation(store, {
    event: "Other",
    starts: "2026-10-05",
    ends: "2026-10-08",
    items: [f.tarp],
    generics: [],
  });

  clock = Date.UTC(2026, 9, 6, 18);
  await mv.checkOut(store, f.stove, { event: "Fall Camp" });
  expect(inv.item(store.state, f.stove)!.movement).toMatchObject({ reservation_id: id });
  expect(res.reservation(store.state, id)).toMatchObject({ ends: "2026-10-03", items: [f.tarp, f.stove] });
});

test("a stack still out keeps an ended event open to a later check-out (FR-RES-39)", async () => {
  clock = Date.UTC(2026, 9, 3, 18);
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  await mv.checkOutPool(store, bowls, { count: 3, event: "Fall Camp" });
  const id = made("Fall Camp")[0]!.id;

  clock = Date.UTC(2026, 9, 5, 18);
  await mv.checkOutPool(store, bowls, { count: 2, event: "Fall Camp" });
  expect(made("Fall Camp")).toHaveLength(1);
  expect(res.reservation(store.state, id)).toMatchObject({ ends: "2026-10-05" });
  expect(res.reservation(store.state, id)!.generics[0]!.quantity).toBe(5);
});

test("gear at a cleaner's home keeps an ended event joinable (FR-RES-39)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 3, 18);
  await mv.checkOut(store, f.stove, { event: "Fall Camp" });
  const id = made("Fall Camp")[0]!.id;
  await mv.sendItemHome(store, f.stove, { cleaner: "Smith" });

  clock = Date.UTC(2026, 9, 5, 18);
  await mv.checkOut(store, f.tarp, { event: "Fall Camp" });
  expect(inv.item(store.state, f.tarp)!.movement).toMatchObject({ reservation_id: id });
  expect(res.reservation(store.state, id)).toMatchObject({ ends: "2026-10-05" });
});

test("a check-out or transfer that is refused leaves no reservation behind (FR-RES-38)", async () => {
  const f = await fixture();
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  await expect(mv.checkOutPool(store, bowls, { count: 0, event: "Fall Camp" })).rejects.toThrow();
  await expect(mv.checkOut(store, f.tents, { event: "Fall Camp" })).rejects.toThrow();
  await mv.checkOut(store, f.stove, { event: "Spring camp" });
  await expect(mv.transfer(store, f.stove, { to: "alice", event: "Fall Camp" })).rejects.toThrow();
  expect(made("Fall Camp")).toEqual([]);
});

test("correcting a linked check-out's event relinks it to the new name's reservation (FR-OUT-41, FR-RES-38)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 3, 18);
  await mv.checkOut(store, f.stove, { event: "Fall Cmap" });
  const typo = made("Fall Cmap")[0]!;

  await mv.changeEvent(store, f.stove, "  Fall  Camp ");
  const [fixed] = made("Fall Camp");
  expect(fixed).toMatchObject({ starts: "2026-10-03", ends: "2026-10-03", items: [f.stove] });
  expect(inv.item(store.state, f.stove)!.movement).toMatchObject({ event: "Fall Camp", reservation_id: fixed!.id });
  // The old one keeps its dates and loses what only the check-out put there.
  expect(res.reservation(store.state, typo.id)).toMatchObject({ starts: "2026-10-03", ends: "2026-10-03", items: [] });

  await mv.changeEvent(store, f.stove, "fall camp");
  expect(made("Fall Camp")).toHaveLength(1);
});

test("correcting keeps what was planned, joins a matching reservation, and no event unlinks (FR-OUT-41)", async () => {
  const f = await fixture();
  clock = Date.UTC(2026, 9, 1, 18);
  const camp = await res.createReservation(store, { ...fall, items: [f.stove], generics: [] });
  const other = await res.createReservation(store, {
    event: "Winter camp",
    starts: "2026-10-01",
    ends: "2026-10-02",
    items: [],
    generics: [],
  });
  await mv.checkOut(store, f.stove, { event: "Fall Camp", reservation_id: camp });

  await mv.changeEvent(store, f.stove, "Winter camp");
  expect(inv.item(store.state, f.stove)!.movement).toMatchObject({ event: "Winter camp", reservation_id: other });
  expect(res.reservation(store.state, other)!.items).toEqual([f.stove]);
  expect(res.reservation(store.state, camp)!.items).toEqual([f.stove]);

  await mv.changeEvent(store, f.stove, null);
  expect(inv.item(store.state, f.stove)!.movement).toMatchObject({ event: null, reservation_id: null });
});

test("a stack's line does not grow when some come back and are packed again (FR-RES-13)", async () => {
  clock = Date.UTC(2026, 9, 1, 18);
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  const id = await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: bowls, quantity: 5 }] });
  const line = () => res.reservation(store.state, id)!.generics[0]!.quantity;

  await mv.checkOutPool(store, bowls, { count: 5, event: "Fall Camp" });
  await mv.checkInPool(store, bowls, { count: 2 });
  await mv.checkOutPool(store, bowls, { count: 2, event: "Fall Camp" });
  expect(line()).toBe(5);
  expect(res.isPacked(res.remaining(store.state, res.reservation(store.state, id)!))).toBe(true);
});

test("a stack's line does not grow when some go home and replacements are packed (FR-RES-13, FR-RES-36)", async () => {
  clock = Date.UTC(2026, 9, 1, 18);
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  const id = await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: bowls, quantity: 5 }] });

  await mv.checkOutPool(store, bowls, { count: 5, event: "Fall Camp" });
  await mv.sendHomeFromPool(store, bowls, { cleaner: "Smith", count: 2 });
  await mv.checkOutPool(store, bowls, { count: 2, event: "Fall Camp" });
  expect(res.reservation(store.state, id)!.generics[0]!.quantity).toBe(5);
  expect(res.isPacked(res.remaining(store.state, res.reservation(store.state, id)!))).toBe(true);
});

test("gear out for cleaning is not packed for its event (FR-RES-36)", async () => {
  const f = await fixture();
  const r = await res.createReservation(store, { ...fall, items: [f.stove], generics: [] });
  await mv.checkOut(store, f.stove, { event: "Fall Camp", reservation_id: r });
  expect(res.isPacked(res.remaining(store.state, res.reservation(store.state, r)!))).toBe(true);

  await mv.sendItemHome(store, f.stove, { cleaner: "Smith" });
  const rem = res.remaining(store.state, res.reservation(store.state, r)!);
  expect(rem.items.map(shown)).toEqual(["Stove"]);
  expect(res.isPacked(rem)).toBe(false);

  await mv.backFromCleaning(store, f.stove);
  expect(res.isPacked(res.remaining(store.state, res.reservation(store.state, r)!))).toBe(true);
});

test("a stack's packed count is what is still out for the event, not at a family's home (FR-RES-36)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  const id = await res.createReservation(store, { ...fall, items: [], generics: [{ item_id: bowls, quantity: 8 }] });
  await res.checkOutPoolLine(store, res.reservation(store.state, id)!, bowls, 8);
  const done = () => res.remaining(store.state, res.reservation(store.state, id)!).generics[0]!.done;
  expect(done()).toBe(8);

  await mv.sendHomeFromPool(store, bowls, { cleaner: "Smith", count: 3 });
  expect(done()).toBe(5);

  await mv.checkInPool(store, bowls, { count: 2 });
  expect(done()).toBe(3);
});
