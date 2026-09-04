import { expect, test } from "vitest";
import { DAY_MS } from "./clock";
import type { State } from "./replay";
import { daysOut, isOverdue, orderParams, outRows, readOrder, rowKey, sortRows, whatIsOut } from "./reports";

const T0 = 1_756_684_800_000;
const out = (holder: string, since: number, event?: string) => ({
  name: "x",
  status: "out" as const,
  holder_id: holder,
  since,
  movement: {
    id: "m",
    type: "checked_out",
    holder_id: holder,
    event: event ?? null,
    reservation_id: null,
    actor_id: holder,
    device_id: "d",
    at: since,
  },
});

const state: State = {
  user: { alice: { name: "Alice" }, bob: { name: "Bob" } },
  setting: { group: { name: "10th", overdue_days: 30 } },
  item: {
    tent: { ...out("bob", T0 - 40 * DAY_MS, "Spring camp"), name: "Tent" },
    stove: { ...out("alice", T0 - 2 * DAY_MS), name: "Stove" },
    axe: { ...out("bob", T0 - 3 * DAY_MS), name: "Axe" },
    rope: { name: "Rope", status: "in", holder_id: null },
    lamp: { ...out("ghost", T0 - 1000), name: "Lamp" },
  },
};

test("what is out is grouped by holder, longest out first, and counts the overdue", () => {
  const report = whatIsOut(state, T0);
  expect(report.total).toBe(4);
  expect(report.overdue).toBe(1);
  expect(report.holders.map((h) => [h.name, h.items.map((i) => i.item.name)])).toEqual([
    ["(unknown person)", ["Lamp"]],
    ["Alice", ["Stove"]],
    ["Bob", ["Tent", "Axe"]],
  ]);
  const tent = report.holders[2]!.items[0]!;
  expect(tent).toMatchObject({ days: 40, event: "Spring camp", overdue: true });
  expect(report.holders[2]!.items[1]!).toMatchObject({ days: 3, event: null, overdue: false });
});

test("no period set means nothing is overdue", () => {
  const noPeriod: State = { ...state, setting: { group: { name: "10th" } } };
  expect(whatIsOut(noPeriod, T0).overdue).toBe(0);
  expect(isOverdue(noPeriod, { id: "tent", ...out("bob", T0 - 400 * DAY_MS), name: "Tent" }, T0)).toBe(false);
});

test("the day count floors, and a clock behind the check-out reads zero", () => {
  const it = { id: "t", name: "T", status: "out" as const, holder_id: "bob", since: T0 - 1.9 * DAY_MS };
  expect(daysOut(it, T0)).toBe(1);
  expect(daysOut(it, T0 - 5 * DAY_MS)).toBe(0);
  expect(isOverdue(state, { ...it, since: T0 - 30 * DAY_MS }, T0)).toBe(true);
  expect(isOverdue(state, { ...it, since: T0 - 29 * DAY_MS }, T0)).toBe(false);
});

test("missing gear is not out, even with a check-out standing (FR-INV-19)", () => {
  const lost: State = { ...state, item: { ...state.item, axe: { ...state.item!.axe!, missing: true } } };
  const report = whatIsOut(lost, T0);
  expect(report.total).toBe(3);
  expect(report.holders.flatMap((h) => h.items.map((i) => i.item.name))).not.toContain("Axe");
});

test("outRows flattens the holder grouping, in the same order", () => {
  const report = whatIsOut(state, T0);
  expect(outRows(report).map((r) => [r.holderName, r.item.name])).toEqual([
    ["(unknown person)", "Lamp"],
    ["Alice", "Stove"],
    ["Bob", "Tent"],
    ["Bob", "Axe"],
  ]);
});

test("sorting by time out ignores holder grouping, longest out first (FR-RPT-12)", () => {
  const report = whatIsOut(state, T0);
  const sorted = sortRows(state, outRows(report), { sort: "days", up: false });
  expect(sorted.map((r) => r.item.name)).toEqual(["Tent", "Axe", "Stove", "Lamp"]);
});

test("sorting by reservation clusters by event name, with event-less rows after named ones (FR-RPT-12)", () => {
  const report = whatIsOut(state, T0);
  const sorted = sortRows(state, outRows(report), { sort: "reservation", up: true });
  // Only the tent carries an event; the rest tie on "no event" and fall back to holder name.
  expect(sorted.map((r) => r.item.name)).toEqual(["Tent", "Lamp", "Stove", "Axe"]);
});

test("sorting by holder is stable within a person: longest out first, then item name", () => {
  // Same days out for both of Bob's items, so the tie falls to the item name.
  const tied: State = {
    ...state,
    item: { ...state.item, tent: { ...state.item!.tent!, since: T0 - 3 * DAY_MS } },
  };
  const report = whatIsOut(tied, T0);
  const sorted = sortRows(tied, outRows(report), { sort: "holder", up: true });
  expect(sorted.map((r) => [r.holderName, r.item.name])).toEqual([
    ["(unknown person)", "Lamp"],
    ["Alice", "Stove"],
    ["Bob", "Axe"],
    ["Bob", "Tent"],
  ]);
});

test("a pool row carries no event, and sorts among the event-less rows by reservation (FR-RPT-11, FR-RPT-12)", () => {
  const withPool: State = {
    ...state,
    item: {
      ...state.item,
      bowls: { name: "Bowls", generic: true, pool: true, pool_in: 5, pool_out: { alice: 4 } },
    },
  };
  const report = whatIsOut(withPool, T0);
  const sorted = sortRows(withPool, outRows(report), { sort: "reservation", up: true });
  // Ties fall back to the grouped order, where a pool's absent day count already puts it last
  // within its holder: Alice's Stove, then her Bowls.
  expect(sorted.map((r) => r.item.name)).toEqual(["Tent", "Lamp", "Stove", "Bowls", "Axe"]);
});

test("a pool lists once per holder, with its count, and carries no days or event of its own (FR-RPT-11)", () => {
  const withPool: State = {
    ...state,
    item: {
      ...state.item,
      bowls: { name: "Bowls", generic: true, pool: true, pool_in: 5, pool_out: { alice: 4, bob: 6 } },
    },
  };
  const report = whatIsOut(withPool, T0);
  expect(report.total).toBe(6);
  expect(report.overdue).toBe(1);
  const alice = report.holders.find((h) => h.name === "Alice")!;
  const bob = report.holders.find((h) => h.name === "Bob")!;
  expect(alice.items.map((i) => i.item.name)).toEqual(["Stove", "Bowls"]);
  expect(alice.items[1]).toMatchObject({ count: 4, days: 0, event: null, overdue: false });
  expect(bob.items.map((i) => i.item.name)).toEqual(["Tent", "Axe", "Bowls"]);
  expect(bob.items[2]).toMatchObject({ count: 6, days: 0, event: null, overdue: false });
});

test("a pool out to two people makes one row each, told apart by holder (FR-RPT-11)", () => {
  const shared: State = {
    ...state,
    item: {
      ...state.item,
      bowls: { name: "Bowls", generic: true, pool: true, pool_in: 3, pool_out: { alice: 4, bob: 3 } },
    },
  };
  const rows = outRows(whatIsOut(shared, T0)).filter((r) => r.item.name === "Bowls");

  // Both rows are the same item, so the item id alone is not a key. rowKey is what the lists use.
  expect(rows.map((r) => [r.holderName, r.count])).toEqual([
    ["Alice", 4],
    ["Bob", 3],
  ]);
  expect(new Set(rows.map((r) => r.item.id)).size).toBe(1);
  expect(new Set(rows.map(rowKey)).size).toBe(2);
});

test("turning a sort around reverses it, but ties still read the same way (FR-RPT-12)", () => {
  const report = whatIsOut(state, T0);
  const up = sortRows(state, outRows(report), { sort: "days", up: true });
  expect(up.map((r) => r.item.name)).toEqual(["Lamp", "Stove", "Axe", "Tent"]);
});

test("the default arrangement is the one the URL leaves out", () => {
  expect(readOrder(new URLSearchParams(""))).toEqual({ sort: "holder", up: true });
  expect(orderParams({ sort: "holder", up: true }).toString()).toBe("");
  expect(orderParams({ sort: "days", up: false }).toString()).toBe("sort=days&dir=down");
  expect(readOrder(new URLSearchParams("sort=days&dir=down"))).toEqual({ sort: "days", up: false });
  // An unknown sort is the default, not a crash.
  expect(readOrder(new URLSearchParams("sort=nonsense"))).toEqual({ sort: "holder", up: true });
});
