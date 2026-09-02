import { expect, test } from "vitest";
import { DAY_MS } from "./clock";
import type { State } from "./replay";
import { daysOut, isOverdue, whatIsOut } from "./reports";

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
