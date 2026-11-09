import { beforeEach, describe, expect, test } from "vitest";
import * as act from "./actions";
import { item } from "./inventory";
import * as mv from "./movement";
import type { Store } from "./store";
import { amountLeft, convert, leftLabel, parseAmount, readingIsStale, roundTenth, weighing } from "./weighing";
import { openStore } from "../ui/codeTestKit";
import { alice, seedUsers } from "../ui/moveTestKit";

describe("the maths", () => {
  test("lb and kg convert both ways", () => {
    expect(convert(10, "lb", "lb")).toBe(10);
    expect(convert(1, "kg", "lb")).toBeCloseTo(2.2046, 4);
    expect(convert(22.0462262185, "lb", "kg")).toBeCloseTo(10, 6);
  });

  test("rounds to a tenth, halves up", () => {
    expect([roundTenth(8.04), roundTenth(8.05), roundTenth(8.46), roundTenth(8)]).toEqual([8, 8.1, 8.5, 8]);
  });

  test("a typed amount is a number of zero or more", () => {
    expect([parseAmount("12.5"), parseAmount(" 0 "), parseAmount(""), parseAmount("-1"), parseAmount("abc")]).toEqual([
      12.5,
      0,
      null,
      null,
      null,
    ]);
  });
});

let store: Store;
let tank: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
  tank = await act.createItem(store, {
    name: "Propane",
    empty_weight: { value: 18, unit: "lb" },
    capacity: { value: 20, unit: "lb" },
  });
});

const left = (id = tank) => amountLeft(store.state, item(store.state, id)!);

describe("what is left", () => {
  test("an item with an empty weight and a capacity is weighed; one without is not", async () => {
    expect(weighing(store.state, item(store.state, tank)!)).toMatchObject({ unit: "lb" });
    const stove = await act.createItem(store, { name: "Stove", empty_weight: { value: 5, unit: "lb" } });
    expect(weighing(store.state, item(store.state, stove)!)).toBeNull();
  });

  test("no reading shows nothing", () => {
    expect(left()).toBeNull();
  });

  test("a weight gives weight and percent over the empty weight, in the item's unit", async () => {
    await mv.weigh(store, tank, { value: 26, unit: "lb" });
    const a = left()!;
    expect(a).toMatchObject({ left: 8, unit: "lb", percent: 40, full: false });
    expect(leftLabel(a)).toBe("About 8 lb left (40%)");
  });

  test("a reading in kg is converted for showing and stored as typed", async () => {
    // 12 kg is 26.455 lb: 8.455 over the empty weight.
    await mv.weigh(store, tank, { value: 12, unit: "kg" });
    expect(left()).toMatchObject({ left: 8.5, unit: "lb", percent: 42 });
    expect(store.pending.at(-1)).toMatchObject({ type: "weighed", payload: { value: 12, unit: "kg" } });
  });

  test("an item kept in kg is shown in kg whatever the reading's unit", async () => {
    const jar = await act.createItem(store, {
      name: "Jar",
      empty_weight: { value: 2, unit: "kg" },
      capacity: { value: 10, unit: "lb" },
    });
    await mv.weigh(store, jar, { value: 4, unit: "kg" });
    // The capacity is 4.5 kg; 2 kg of contents is 44 percent.
    expect(left(jar)).toMatchObject({ left: 2, unit: "kg", percent: 44 });
  });

  test("below the empty weight is none left, above full is full, never outside 0 to 100", async () => {
    await mv.weigh(store, tank, { value: 10, unit: "lb" });
    expect(left()).toMatchObject({ left: 0, percent: 0 });
    await mv.weigh(store, tank, { value: 90, unit: "lb" });
    expect(left()).toMatchObject({ left: 20, percent: 100 });
  });

  test("Refilled is full, and the latest of weighing and refill wins", async () => {
    await mv.weigh(store, tank, { value: 26, unit: "lb" });
    await mv.refill(store, tank);
    const a = left()!;
    expect(a).toMatchObject({ left: 20, percent: 100, full: true });
    expect(leftLabel(a)).toBe("Full (20 lb)");
    await mv.weigh(store, tank, { value: 30, unit: "lb" });
    expect(left()).toMatchObject({ left: 12, percent: 60, full: false });
  });

  test("Unknown clears the last reading", async () => {
    await mv.weigh(store, tank, { value: 26, unit: "lb" });
    await mv.weigh(store, tank, null);
    expect(left()).toBeNull();
    expect(store.pending.at(-1)).toMatchObject({ type: "weighed", payload: { value: null } });
  });

  test("a unit has its own empty weight and its generic's capacity unless it has its own", async () => {
    const generic = await act.createGeneric(store, { name: "Tanks", capacity: { value: 20, unit: "lb" } });
    const unit = await act.createUnit(store, { parent_id: generic, number: "1" });
    expect(weighing(store.state, item(store.state, unit)!)).toBeNull();
    await act.updateItem(store, unit, { empty_weight: { value: 8, unit: "kg" } });
    expect(weighing(store.state, item(store.state, unit)!)).toMatchObject({ unit: "kg" });
    await mv.refill(store, unit);
    expect(left(unit)).toMatchObject({ left: 9.1, unit: "kg", percent: 100 });
    await act.updateItem(store, unit, { capacity: { value: 5, unit: "kg" } });
    expect(left(unit)).toMatchObject({ left: 5, percent: 100 });
  });

  test("a generic is never weighed, and weighing needs the setup", async () => {
    const generic = await act.createGeneric(store, {
      name: "Tanks",
      empty_weight: { value: 8, unit: "kg" },
      capacity: { value: 20, unit: "lb" },
    });
    const plain = await act.createItem(store, { name: "Tent" });
    expect(weighing(store.state, item(store.state, generic)!)).toBeNull();
    await expect(mv.weigh(store, plain, { value: 5, unit: "lb" })).rejects.toThrow("empty weight and capacity");
    await expect(mv.refill(store, plain)).rejects.toThrow("empty weight and capacity");
    await expect(mv.weigh(store, tank, { value: -1, unit: "lb" })).rejects.toThrow("zero or more");
  });

  test("editing a weight to the same number and unit records nothing", async () => {
    const before = store.pending.length;
    await act.updateItem(store, tank, { capacity: { value: 20, unit: "lb" } });
    expect(store.pending.length).toBe(before);
    await act.updateItem(store, tank, { capacity: { value: 20, unit: "kg" } });
    expect(store.pending.at(-1)).toMatchObject({
      type: "field_changed",
      payload: { field: "capacity", value: { value: 20, unit: "kg" }, old: { value: 20, unit: "lb" } },
    });
  });
});

describe("check-in", () => {
  test("a weight records the reading after the check-in; none leaves it, stale", async () => {
    await mv.checkOut(store, tank, { event: "Camp", packing: true });
    await mv.checkIn(store, tank, { weight: { value: 28, unit: "lb" } });
    expect(store.pending.slice(-2).map((e) => e.type)).toEqual(["checked_in", "weighed"]);
    expect(left()).toMatchObject({ left: 10, percent: 50 });

    await mv.checkOut(store, tank, { event: "Camp", packing: true });
    await mv.checkIn(store, tank);
    // Kept, but taken before this trip, so not shown as what is left (FR-INV-69).
    expect(left()).toBeNull();
    expect(readingIsStale(store.state, item(store.state, tank)!)).toBe(true);
  });

  test("no weight records nothing and keeps a fresh reading", async () => {
    await mv.checkOut(store, tank, { event: "Camp", packing: true });
    await mv.weigh(store, tank, { value: 28, unit: "lb" });
    await mv.checkIn(store, tank);
    expect(store.pending.at(-1)?.type).toBe("checked_in");
    expect(left()).toMatchObject({ left: 10, percent: 50 });
  });

  test("an item that is not weighed records no weighing", async () => {
    const tent = await act.createItem(store, { name: "Tent" });
    await mv.checkOut(store, tent, { packing: true });
    await mv.checkIn(store, tent, { weight: { value: 5, unit: "lb" } });
    expect(store.pending.some((e) => e.type === "weighed")).toBe(false);
  });
});

describe("unsound data", () => {
  const LATER = Date.now() + 1e9;
  const put = (fields: Record<string, unknown>) =>
    store.receive(
      [
        {
          id: "09" + "0".repeat(24),
          entity_type: "item",
          entity_id: tank,
          type: "field_changed",
          actor_id: "server",
          device_id: "server",
          device_seq: 1,
          occurred_at: LATER,
          clock_offset: 0,
          effective_at: LATER,
          received_at: LATER,
          seq: 5000,
          payload: { field: Object.keys(fields)[0]!, value: Object.values(fields)[0], old: null },
        },
      ],
      5000,
    );

  test.each([
    ["a zero capacity", "capacity", { value: 0, unit: "lb" }],
    ["a negative capacity", "capacity", { value: -4, unit: "lb" }],
    ["a text weight", "empty_weight", { value: "18", unit: "lb" }],
    ["an unknown unit", "empty_weight", { value: 18, unit: "oz" }],
    ["an infinite weight", "empty_weight", { value: Infinity, unit: "lb" }],
  ])("%s means not weighed, with no NaN", async (_n, field, value) => {
    await mv.refill(store, tank);
    await put({ [field]: value });
    const it = item(store.state, tank)!;
    expect(weighing(store.state, it)).toBeNull();
    expect(amountLeft(store.state, it)).toBeNull();
  });

  test("a malformed reading shows nothing", async () => {
    await put({ reading: { value: "9", unit: "lb", at: 1 } });
    expect(left()).toBeNull();
  });
});

describe("a make-single unit", () => {
  test("keeps its generic's capacity", async () => {
    const generic = await act.createGeneric(store, { name: "Tanks", capacity: { value: 20, unit: "lb" } });
    const unit = await act.createUnit(store, { parent_id: generic, number: "1" });
    await act.updateItem(store, unit, { empty_weight: { value: 18, unit: "lb" } });
    await act.makeSingle(store, generic);
    expect(item(store.state, unit)).toMatchObject({ capacity: { value: 20, unit: "lb" } });
    expect(weighing(store.state, item(store.state, unit)!)).not.toBeNull();
  });

  test("keeps its own capacity when it has one", async () => {
    const generic = await act.createGeneric(store, { name: "Tanks", capacity: { value: 20, unit: "lb" } });
    const unit = await act.createUnit(store, { parent_id: generic, number: "1" });
    await act.updateItem(store, unit, { capacity: { value: 30, unit: "lb" } });
    await act.makeSingle(store, generic);
    expect(item(store.state, unit)?.capacity).toEqual({ value: 30, unit: "lb" });
  });
});
