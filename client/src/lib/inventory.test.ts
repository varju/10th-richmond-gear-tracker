import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { openDb } from "./db";
import * as inv from "./inventory";
import { checkOut } from "./movement";
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
  const t1 = await act.createItem(store, { name: "Tent 1", home_location_id: cold, sub_location: "shelf 4" });
  const t2 = await act.createItem(store, { name: "Tent 2", home_location_id: cold, sub_location: "shelf 4" });
  const stove = await act.createItem(store, { name: "Stove", home_location_id: warm, sub_location: "" });
  return { cold, warm, t1, t2, stove };
}

/** A generic with three units, one of them nicknamed, plus the single items above. */
async function withUnits() {
  const f = await fixture();
  const tents = await act.createGeneric(store, { name: "4-person tent", home_location_id: f.cold });
  const u1 = await act.addUnit(store, tents);
  const u2 = await act.addUnit(store, tents);
  const u3 = await act.createUnit(store, { parent_id: tents, number: "7", nickname: "patched fly" });
  return { ...f, tents, u1, u2, u3 };
}

const names = (filter: inv.Filter) => inv.search(store.state, filter).map((i) => inv.displayName(store.state, i));

test("search matches every word against the name and the home", async () => {
  const f = await fixture();
  expect(names({})).toEqual(["Stove", "Tent 1", "Tent 2"]);
  expect(names({ query: "tent 2" })).toEqual(["Tent 2"]);
  expect(names({ query: "shelf" })).toEqual(["Tent 1", "Tent 2"]);
  expect(names({ location_id: f.warm })).toEqual(["Stove"]);
  expect(names({ sub_location: "shelf 4", status: "in" })).toEqual(["Tent 1", "Tent 2"]);
});

test("a unit is named by its generic, its number and its nickname (FR-INV-22)", async () => {
  const f = await withUnits();
  const name = (id: string) => inv.displayName(store.state, inv.item(store.state, id)!);
  expect(name(f.u1)).toBe("4-person tent #1");
  expect(name(f.u3)).toBe("4-person tent #7 (patched fly)");
  expect(inv.displayName(store.state, inv.item(store.state, f.tents)!)).toBe("4-person tent");
  // A unit starts at its generic's home (FR-INV-29).
  expect(inv.item(store.state, f.u1)?.home_location_id).toBe(f.cold);
  // The generic itself never moves, so it has no status.
  expect(inv.item(store.state, f.tents)?.status).toBeUndefined();
});

test("the number offered follows the largest one in use, and is unique under the parent (FR-INV-23)", async () => {
  const f = await withUnits();
  expect(inv.nextNumber(store.state, f.tents)).toBe("8");
  expect(inv.numberTaken(store.state, f.tents, "7")).toBe(true);
  expect(inv.numberTaken(store.state, f.tents, "7", f.u3)).toBe(false);
  await expect(act.createUnit(store, { parent_id: f.tents, number: " 7 " })).rejects.toThrow("#7 is taken");
  await expect(act.createUnit(store, { parent_id: f.t1, number: "1" })).rejects.toThrow("not a generic item");
  await expect(act.createUnit(store, { parent_id: f.tents, number: "  " })).rejects.toThrow("a unit needs a number");
});

test("a number is what is written on the gear, and units sort numbers first (FR-INV-23)", async () => {
  const f = await withUnits();
  const lettered = await act.createUnit(store, { parent_id: f.tents, number: " 3b " });
  await act.createUnit(store, { parent_id: f.tents, number: "10" });
  expect(inv.item(store.state, lettered)?.number).toBe("3b");
  expect(inv.displayName(store.state, inv.item(store.state, lettered)!)).toBe("4-person tent #3b");
  // Whole numbers in numeric order, so 7 comes before 10; the rest as text, after.
  expect(inv.unitsOf(store.state, f.tents).map((u) => u.number)).toEqual(["1", "2", "7", "10", "3b"]);
  // A letter in use is still offered a whole number.
  expect(inv.nextNumber(store.state, f.tents)).toBe("11");
});

test("a unit is searched by its generic's name, its nickname and its number", async () => {
  const f = await withUnits();
  expect(names({ query: "4-person" })).toEqual([
    "4-person tent #1",
    "4-person tent #2",
    "4-person tent #7 (patched fly)",
  ]);
  expect(names({ query: "patched" })).toEqual(["4-person tent #7 (patched fly)"]);
  expect(names({ query: "#2" })).toEqual(["4-person tent #2"]);
  // The generic is not a row in search; it is a row in the list.
  expect(names({}).includes("4-person tent")).toBe(false);
  expect(f.u2).toBeTruthy();
});

test("the list is one row per generic with counts, single items on their own (FR-INV-25)", async () => {
  const f = await withUnits();
  await checkOut(store, f.u1, { event: "Fall Camp" });
  const list = inv.rows(store.state, {});
  expect(list.map((r) => [r.kind, r.name])).toEqual([
    ["generic", "4-person tent"],
    ["single", "Stove"],
    ["single", "Tent 1"],
    ["single", "Tent 2"],
  ]);
  const tents = list[0] as inv.GenericRow;
  expect(tents.counts).toEqual({ total: 3, in: 2 });
  expect(tents.units.map((u) => u.number)).toEqual(["1", "2", "7"]);
  expect(inv.countItems(list)).toBe(6);
});

test("filters apply to units, and show the generics that have any (FR-INV-25)", async () => {
  const f = await withUnits();
  await checkOut(store, f.u1, { event: "Fall Camp" });
  const out = inv.rows(store.state, { status: "out" });
  expect(out.map((r) => r.name)).toEqual(["4-person tent"]);
  expect((out[0] as inv.GenericRow).units.map((u) => u.id)).toEqual([f.u1]);
  // #7 was made without a home, so a location filter drops it from the row.
  const cold = inv.rows(store.state, { location_id: f.cold });
  expect((cold[0] as inv.GenericRow).counts.total).toBe(2);
  // Searching the generic's name finds the row even with no units under it.
  const empty = await act.createGeneric(store, { name: "Dutch oven" });
  expect(inv.rows(store.state, { query: "dutch" }).map((r) => r.name)).toEqual(["Dutch oven"]);
  expect(empty).toBeTruthy();
});

test("marking an item generic keeps it, under the number given (FR-INV-26)", async () => {
  const f = await fixture();
  await act.bindCode(store, "ABCDEFGH23", f.t1);
  await checkOut(store, f.t1, { event: "Fall Camp" });
  const genericId = await act.makeGeneric(store, f.t1);

  const generic = inv.item(store.state, genericId)!;
  const unit = inv.item(store.state, f.t1)!;
  expect(generic).toMatchObject({ name: "Tent 1", generic: true, home_location_id: f.cold });
  expect(unit).toMatchObject({ parent_id: genericId, number: "1", name: null, status: "out" });
  expect(inv.displayName(store.state, unit)).toBe("Tent 1 #1");
  // The sticker and the movement stay where they were.
  expect(inv.currentCode(store.state, f.t1)?.id).toBe("ABCDEFGH23");
  expect(unit.movement?.event).toBe("Fall Camp");
  await expect(act.makeGeneric(store, f.t1)).rejects.toThrow("already one of several");

  // The number is the person's to pick: what is painted on the gear (FR-INV-23).
  const lettered = await act.makeGeneric(store, f.t2, " B ");
  expect(inv.displayName(store.state, inv.item(store.state, f.t2)!)).toBe("Tent 2 #B");
  expect(lettered).toBeTruthy();
  await expect(act.makeGeneric(store, f.stove, " ")).rejects.toThrow("a unit needs a number");
});

test("grouping two singles makes a generic from the picked item's name (FR-INV-30)", async () => {
  const f = await fixture();
  await act.bindCode(store, "ABCDEFGH23", f.t1);
  await checkOut(store, f.t1, { event: "Fall Camp" });
  const genericId = await act.groupWith(store, f.t1, f.t2, { mine: "2", other: "1" });

  expect(inv.item(store.state, genericId)).toMatchObject({ name: "Tent 2", generic: true });
  expect(inv.displayName(store.state, inv.item(store.state, f.t2)!)).toBe("Tent 2 #1");
  expect(inv.displayName(store.state, inv.item(store.state, f.t1)!)).toBe("Tent 2 #2");
  // Both stay: neither points at the other, and each keeps its own home and history.
  expect(inv.item(store.state, f.t1)?.merged_into).toBeUndefined();
  expect(inv.item(store.state, f.t1)?.home_location_id).toBe(f.cold);
  expect(inv.currentCode(store.state, f.t1)?.id).toBe("ABCDEFGH23");
  expect(inv.item(store.state, f.t1)?.movement?.event).toBe("Fall Camp");
});

test("grouping with a generic, or one of its units, joins the one already there (FR-INV-30)", async () => {
  const f = await withUnits();
  await act.groupWith(store, f.t1, f.tents, { mine: "8" });
  expect(inv.displayName(store.state, inv.item(store.state, f.t1)!)).toBe("4-person tent #8");

  // A unit stands for its generic: joining it joins the generic.
  await act.groupWith(store, f.t2, f.u1, { mine: "9" });
  expect(inv.displayName(store.state, inv.item(store.state, f.t2)!)).toBe("4-person tent #9");
  expect(inv.generics(store.state)).toHaveLength(1);
});

test("a group is refused before anything is written (FR-INV-30)", async () => {
  const f = await withUnits();
  await expect(act.groupWith(store, f.t1, f.t1, { mine: "2" })).rejects.toThrow("cannot be grouped with itself");
  await expect(act.groupWith(store, f.t1, f.t2, { mine: "1", other: "1" })).rejects.toThrow(
    "the two need different numbers",
  );
  await expect(act.groupWith(store, f.t1, f.tents, { mine: "1" })).rejects.toThrow("#1 is taken");
  await expect(act.groupWith(store, f.t1, f.tents, { mine: " " })).rejects.toThrow("a unit needs a number");
  await expect(act.groupWith(store, f.u1, f.t1, { mine: "1" })).rejects.toThrow("already one of several");
  // Nothing above got as far as a write.
  expect(inv.generics(store.state).map((g) => g.id)).toEqual([f.tents]);
  expect(inv.item(store.state, f.t1)?.parent_id).toBeUndefined();
});

test("a generic retires only when every unit has (FR-INV-27)", async () => {
  const f = await withUnits();
  await expect(act.retireItem(store, f.tents)).rejects.toThrow("retire its units first");
  for (const id of [f.u1, f.u2, f.u3]) await act.retireItem(store, id);
  await act.retireItem(store, f.tents);
  expect(inv.item(store.state, f.tents)?.retired).toBe(true);
});

test("a unit moves to another generic, and a taken number is bumped (FR-INV-28)", async () => {
  const f = await withUnits();
  const other = await act.createGeneric(store, { name: "3-person tent" });
  await act.createUnit(store, { parent_id: other, number: "1" });
  await act.moveUnit(store, f.u1, other);
  expect(inv.item(store.state, f.u1)).toMatchObject({ parent_id: other, number: "2" });
  expect(inv.unitsOf(store.state, f.tents).map((u) => u.id)).toEqual([f.u2, f.u3]);
  await expect(act.moveUnit(store, f.t1, other)).rejects.toThrow("not a unit");
});

test("recent generics come back most recently touched first (FR-INV-24)", async () => {
  const f = await withUnits();
  const other = await act.createGeneric(store, { name: "3-person tent" });
  expect(inv.recentGenerics(store.state).map((g) => g.name)).toEqual(["3-person tent", "4-person tent"]);
  await act.addUnit(store, f.tents);
  expect(inv.recentGenerics(store.state).map((g) => g.name)).toEqual(["4-person tent", "3-person tent"]);
  expect(other).toBeTruthy();
});

test("search over 500 items stays well inside 200 ms", async () => {
  const cold = await act.createLocation(store, "Cold locker");
  const state = structuredClone(store.state);
  state.item = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => [
      `i${i}`,
      {
        name: `Item ${i} ${i % 7 === 0 ? "tent" : "tarp"}`,
        home_location_id: cold,
        sub_location: `shelf ${i % 12}`,
        status: "in",
        holder_id: null,
      },
    ]),
  );
  const started = performance.now();
  for (let i = 0; i < 20; i++) inv.search(state, { query: "tent shelf 3" });
  expect((performance.now() - started) / 20).toBeLessThan(200);
});

test("retired items are hidden unless asked for, and come back with their code", async () => {
  const f = await fixture();
  await act.bindCode(store, "ABCDEFGH23", f.t1);
  await act.retireItem(store, f.t1);
  expect(inv.search(store.state, {}).map((i) => i.name)).toEqual(["Stove", "Tent 2"]);
  expect(inv.search(store.state, { retired: true }).map((i) => i.name)).toEqual(["Tent 1"]);
  await act.unretireItem(store, f.t1);
  expect(inv.currentCode(store.state, f.t1)?.id).toBe("ABCDEFGH23");
});

test("the item's current code is the latest binding; older ones still resolve", async () => {
  const f = await fixture();
  await act.bindCode(store, "ABCDEFGH23", f.t1);
  await act.bindCode(store, "BCDEFGHJ34", f.t1);
  expect(inv.codeStatus(store.state, "ABCDEFGH23")).toBe("replaced");
  expect(inv.codeStatus(store.state, "BCDEFGHJ34")).toBe("assigned");
  expect(inv.codeStatus(store.state, "ZZZZZZZZZZ")).toBe("unknown");
  expect(inv.code(store.state, "ABCDEFGH23")?.item_id).toBe(f.t1);
});

test("updates record only what changed, with the old value", async () => {
  const f = await fixture();
  const before = store.pending.length;
  await act.updateItem(store, f.t1, { name: "Tent 1", sub_location: "shelf 5" });
  const added = store.pending.slice(before);
  expect(added.map((e) => e.payload)).toEqual([{ field: "sub_location", value: "shelf 5", old: "shelf 4" }]);
  expect(inv.item(store.state, f.t1)?.modified_at).toBeGreaterThan(inv.item(store.state, f.t1)!.added_at!);
});

test("a location in use cannot be deleted, and the error names the items", async () => {
  const f = await fixture();
  await expect(act.deleteLocation(store, f.cold)).rejects.toThrow("in use by Tent 1, Tent 2");
  await act.updateItem(store, f.stove, { home_location_id: null });
  await act.deleteLocation(store, f.warm);
  expect(inv.locations(store.state).map((l) => l.name)).toEqual(["Cold locker"]);
  expect(inv.locationName(store.state, f.warm)).toBe("Warm locker"); // hidden from pickers, still named
});

test("shelf labels are the ones in use, optionally within one location", async () => {
  const f = await fixture();
  await act.updateItem(store, f.stove, { sub_location: "bin 2" });
  expect(inv.subLocations(store.state)).toEqual(["bin 2", "shelf 4"]);
  expect(inv.subLocations(store.state, f.cold)).toEqual(["shelf 4"]);
});

test("group settings are created once, then changed", async () => {
  await act.setGroup(store, { name: "10th Richmond", code_url: "https://example.org" });
  await act.setGroup(store, { name: "10th Richmond Sea Scouts" });
  expect(inv.group(store.state)).toMatchObject({
    name: "10th Richmond Sea Scouts",
    code_url: "https://example.org",
  });
  expect(store.pending.map((e) => e.type)).toEqual(["created", "field_changed"]);
});

test("missing is a field, filterable, and does not change status (FR-INV-19)", async () => {
  const f = await fixture();
  await act.markMissing(store, f.stove);
  expect(inv.item(store.state, f.stove)).toMatchObject({ missing: true, status: "in" });
  const names = (filter: inv.Filter) => inv.search(store.state, filter).map((i) => i.name);
  expect(names({ status: "missing" })).toEqual(["Stove"]);
  expect(names({ status: "in" })).toEqual(["Stove", "Tent 1", "Tent 2"]);
  await act.seen(store, f.stove);
  expect(inv.item(store.state, f.stove)?.missing).toBe(false);
  // Seen again records nothing.
  const before = store.pending.length;
  await act.seen(store, f.stove);
  expect(store.pending.length).toBe(before);
});

test("a location is browsed shelf by shelf, no shelf last, retired gear left out (FR-INV-10)", async () => {
  const f = await fixture();
  const bag = await act.createItem(store, { name: "Bag", home_location_id: f.cold, sub_location: "" });
  await act.createItem(store, { name: "Axe", home_location_id: f.cold, sub_location: "bin 1" });
  const old = await act.createItem(store, { name: "Old tent", home_location_id: f.cold, sub_location: "shelf 4" });
  await act.retireItem(store, old);
  expect(inv.bySubLocation(store.state, f.cold).map((s) => [s.sub_location, s.items.map((i) => i.name)])).toEqual([
    ["bin 1", ["Axe"]],
    ["shelf 4", ["Tent 1", "Tent 2"]],
    ["", ["Bag"]],
  ]);
  expect(inv.atLocation(store.state, f.cold).map((i) => i.id)).toContain(bag);
  expect(inv.bySubLocation(store.state, f.warm).map((s) => [s.sub_location, s.items.map((i) => i.name)])).toEqual([
    ["", ["Stove"]],
  ]);
});

test("the price is stored to the cent, and blank is no price (FR-INV-12)", async () => {
  const id = await act.createItem(store, {
    name: "Stove",
    price: "$1,249.999",
    purchase_date: "2024-03-01",
  });
  expect(inv.item(store.state, id)).toMatchObject({ price: 1250, purchase_date: "2024-03-01" });
  await act.updateItem(store, id, { price: "" });
  expect(inv.item(store.state, id)?.price).toBeNull();
  expect(act.price("abc")).toBeNull();
  expect(act.price(-1)).toBeNull();
  expect(act.price(12.345)).toBe(12.35);
});

test("a merged duplicate leaves the list, and its sticker finds the survivor (FR-INV-13)", async () => {
  const f = await fixture();
  await act.bindCode(store, "ABCDEFGH23", f.t1);
  await act.bindCode(store, "BCDEFGHJ34", f.t2);
  await act.mergeItem(store, f.t1, f.t2);

  expect(inv.search(store.state, {}).map((i) => i.name)).toEqual(["Stove", "Tent 2"]);
  expect(inv.resolveItem(store.state, f.t1)).toBe(f.t2);
  expect(inv.resolveItem(store.state, f.t2)).toBe(f.t2);
  expect(inv.aliases(store.state, f.t2)).toEqual([f.t2, f.t1]);
  expect(inv.codesFor(store.state, f.t2).map((c) => c.id)).toEqual(["BCDEFGHJ34", "ABCDEFGH23"]);
  expect(inv.codeStatus(store.state, "ABCDEFGH23")).toBe("replaced");
  expect(inv.codeStatus(store.state, "BCDEFGHJ34")).toBe("assigned");
  expect(store.pending.at(-1)?.payload).toEqual({ field: "merged_into", value: f.t2, old: null });

  await act.unmergeItem(store, f.t1);
  expect(inv.search(store.state, {}).map((i) => i.name)).toEqual(["Stove", "Tent 1", "Tent 2"]);
  expect(inv.currentCode(store.state, f.t1)?.id).toBe("ABCDEFGH23");
});

test("a merge follows a chain, and refuses a loop", async () => {
  const f = await fixture();
  await act.mergeItem(store, f.t1, f.t2);
  await act.mergeItem(store, f.t2, f.stove);
  expect(inv.resolveItem(store.state, f.t1)).toBe(f.stove);
  expect(inv.aliases(store.state, f.stove)).toEqual([f.stove, f.t2, f.t1]);
  await act.unmergeItem(store, f.t2);
  // t1 still points at t2, so t2 cannot point back: a survivor is never itself merged.
  await expect(act.mergeItem(store, f.t2, f.t1)).rejects.toThrow("already merged");
});

test("merging needs an Admin and two items that are in, unretired and unmerged", async () => {
  const f = await fixture();
  await expect(act.mergeItem(store, f.t1, f.t1)).rejects.toThrow("itself");
  await expect(act.mergeItem(store, f.t1, "nope")).rejects.toThrow("no such item");
  await act.retireItem(store, f.stove);
  await expect(act.mergeItem(store, f.t1, f.stove)).rejects.toThrow("retired");
  await act.mergeItem(store, f.t1, f.t2);
  await expect(act.mergeItem(store, f.t1, f.t2)).rejects.toThrow("already merged");
  await store.setMeta({ user: { id: "carol", name: "Carol", role: "user", active: true } });
  await expect(act.mergeItem(store, f.t2, f.t1)).rejects.toThrow("Admins only");
});

test("a number the server sent as a whole number still reads as text (FR-INV-23)", async () => {
  // Events written before numbers were text hold an integer, and the snapshot
  // carries it through. Reading it as a string is what blanked the app.
  await store.bootstrap(
    {
      item: {
        tents: { name: "4-person tent", generic: true },
        u1: { parent_id: "tents", number: 10 },
        u2: { parent_id: "tents", number: 2 },
      },
    },
    1,
  );
  expect(inv.unitsOf(store.state, "tents").map(inv.numberOf)).toEqual(["2", "10"]);
  expect(inv.displayName(store.state, inv.item(store.state, "u1")!)).toBe("4-person tent #10");
  expect(inv.numberTaken(store.state, "tents", "2")).toBe(true);
  expect(inv.nextNumber(store.state, "tents")).toBe("11");
});

test("a deleted item leaves every list, and its record still names it (FR-INV-32)", async () => {
  const f = await withUnits();
  await act.deleteItem(store, f.t1);
  expect(inv.items(store.state).map((i) => i.name)).not.toContain("Tent 1");
  expect(names({})).toEqual([
    "4-person tent #1",
    "4-person tent #2",
    "4-person tent #7 (patched fly)",
    "Stove",
    "Tent 2",
  ]);
  expect(names({ retired: true })).toEqual([]);
  expect(inv.rows(store.state, {}).map((r) => r.name)).toEqual(["4-person tent", "Stove", "Tent 2"]);
  // The row stays, so the item's own page and an old reference can still name it.
  expect(inv.item(store.state, f.t1)).toMatchObject({ name: "Tent 1", deleted: true });
  expect(inv.nameOf(store.state, f.t1)).toBe("Tent 1");
});

test("a deleted unit leaves its generic's row and does not retire it (FR-INV-32)", async () => {
  const f = await withUnits();
  await act.deleteItem(store, f.u1);
  const row = inv.rows(store.state, {})[0] as inv.GenericRow;
  expect(row.units.map((u) => u.id)).toEqual([f.u2, f.u3]);
  expect(inv.unitsOf(store.state, f.tents).map((u) => u.id)).toEqual([f.u2, f.u3]);
  expect(inv.item(store.state, f.tents)?.retired).toBeUndefined();
});

test("deleting needs an Admin, an item that is in, and a generic with no units (FR-INV-32)", async () => {
  const f = await withUnits();
  await expect(act.deleteItem(store, "nope")).rejects.toThrow("no such item");
  await expect(act.deleteItem(store, f.tents)).rejects.toThrow("delete its units first");
  await checkOut(store, f.t1, { event: "Fall Camp" });
  await expect(act.deleteItem(store, f.t1)).rejects.toThrow("check it in first");
  await act.mergeItem(store, f.t2, f.stove);
  await expect(act.deleteItem(store, f.t2)).rejects.toThrow("merged into another");
  // A retired item may go: retiring is for gear written off, deleting for a record made in error.
  await act.retireItem(store, f.stove);
  await act.deleteItem(store, f.stove);
  expect(inv.item(store.state, f.stove)?.deleted).toBe(true);
  // The generic goes once every unit has. Tent 1 is out, so it stays.
  for (const u of [f.u1, f.u2, f.u3]) await act.deleteItem(store, u);
  await act.deleteItem(store, f.tents);
  expect(inv.rows(store.state, {}).map((r) => r.name)).toEqual(["Tent 1"]);

  await store.setMeta({ user: { id: "carol", name: "Carol", role: "user", active: true } });
  await expect(act.deleteItem(store, f.t1)).rejects.toThrow("Admins only");
});

test("a unit's category is its generic's, not its own (FR-SET-07)", async () => {
  const f = await withUnits();
  const tents = await act.createCategory(store, "Tents");
  await act.updateItem(store, f.tents, { category_ids: [tents] });
  expect(inv.categoriesOf(store.state, inv.item(store.state, f.tents)!)).toEqual([tents]);
  expect(inv.categoriesOf(store.state, inv.item(store.state, f.u1)!)).toEqual([tents]);
  expect(inv.categoriesOf(store.state, inv.item(store.state, f.stove)!)).toEqual([]);
});

test("an item can carry several categories, listed under all of them (FR-SET-07)", async () => {
  const f = await fixture();
  const camp = await act.createCategory(store, "Camp kitchen");
  const cold = await act.createCategory(store, "Cold weather");
  await act.updateItem(store, f.stove, { category_ids: [camp, cold] });
  expect(inv.categoriesOf(store.state, inv.item(store.state, f.stove)!)).toEqual([camp, cold]);
  expect(inv.categoryNames(store.state, inv.item(store.state, f.stove)!)).toBe("Camp kitchen, Cold weather");

  const groups = inv
    .byCategory(store.state, inv.rows(store.state, {}))
    .map((g) => [g.category?.name ?? null, g.rows.map((r) => r.name)]);
  expect(groups).toEqual([
    ["Camp kitchen", ["Stove"]],
    ["Cold weather", ["Stove"]],
    [null, ["Tent 1", "Tent 2"]],
  ]);

  const names = (filter: inv.Filter) => inv.search(store.state, filter).map((i) => inv.displayName(store.state, i));
  expect(names({ category_id: camp })).toEqual(["Stove"]);
  expect(names({ category_id: cold })).toEqual(["Stove"]);
});

test("an old item resolves category_id until category_ids is written, even to empty (FR-SET-07)", async () => {
  const f = await fixture();
  const camp = await act.createCategory(store, "Camp kitchen");
  // As an old device would have recorded it, before category_ids existed.
  await store.record({
    entity_type: "item",
    entity_id: f.stove,
    type: "field_changed",
    actor_id: "alice",
    payload: { field: "category_id", value: camp, old: null },
  });
  expect(inv.categoriesOf(store.state, inv.item(store.state, f.stove)!)).toEqual([camp]);

  await act.updateItem(store, f.stove, { category_ids: [] });
  expect(inv.categoriesOf(store.state, inv.item(store.state, f.stove)!)).toEqual([]);
});

test("search by category matches units through their generic (FR-SET-07)", async () => {
  const f = await withUnits();
  const tents = await act.createCategory(store, "Tents");
  await act.updateItem(store, f.tents, { category_ids: [tents] });
  const names = (filter: inv.Filter) => inv.search(store.state, filter).map((i) => inv.displayName(store.state, i));
  expect(names({ category_id: tents })).toEqual([
    "4-person tent #1",
    "4-person tent #2",
    "4-person tent #7 (patched fly)",
  ]);
  expect(names({ category_id: f.cold })).toEqual([]);
});

test("byCategory groups by category name, uncategorised last, empty groups left out (FR-SET-07)", async () => {
  const f = await fixture();
  const camp = await act.createCategory(store, "Camp kitchen");
  await act.createCategory(store, "Shelter"); // never used: its group should not appear
  await act.updateItem(store, f.stove, { category_ids: [camp] });
  const groups = inv
    .byCategory(store.state, inv.rows(store.state, {}))
    .map((g) => [g.category?.name ?? null, g.rows.map((r) => r.name)]);
  expect(groups).toEqual([
    ["Camp kitchen", ["Stove"]],
    [null, ["Tent 1", "Tent 2"]],
  ]);
});

test("a row whose category was deleted since counts as no category (FR-SET-07)", async () => {
  const f = await fixture();
  const camp = await act.createCategory(store, "Camp kitchen");
  await act.updateItem(store, f.stove, { category_ids: [camp] });
  // Deleted from another device, while this one still has an item pointing at it.
  await store.record({
    entity_type: "category",
    entity_id: camp,
    type: "field_changed",
    actor_id: "alice",
    payload: { field: "deleted", value: true, old: null },
  });
  const groups = inv
    .byCategory(store.state, inv.rows(store.state, {}))
    .map((g) => [g.category?.name ?? null, g.rows.map((r) => r.name)]);
  expect(groups).toEqual([[null, ["Stove", "Tent 1", "Tent 2"]]]);
});

test("a category in use cannot be deleted, and the error names the items (FR-SET-05)", async () => {
  const f = await withUnits();
  const tents = await act.createCategory(store, "Tents");
  await act.updateItem(store, f.tents, { category_ids: [tents] });
  await expect(act.deleteCategory(store, tents)).rejects.toThrow("in use by 4-person tent");
  await act.updateItem(store, f.tents, { category_ids: [] });
  await act.deleteCategory(store, tents);
  expect(inv.categories(store.state)).toEqual([]);
});
