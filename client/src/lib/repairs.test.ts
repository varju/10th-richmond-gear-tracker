import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { openDb } from "./db";
import * as notes from "./notes";
import * as rep from "./repairs";
import { Store } from "./store";

let store: Store;
let clock = 1_000;
let tent: string;

beforeEach(async () => {
  clock = 1_000;
  store = await Store.open(await openDb("test", new IDBFactory()), () => clock++);
  await store.setMeta({ user: { id: "alice", name: "Alice", role: "user", active: true } });
  tent = await act.createItem(store, { name: "Tent" });
});

test("a ticket opens open, against its item, with the description trimmed (FR-REP-01)", async () => {
  const id = await rep.raiseTicket(store, tent, "  zipper broken ");
  expect(rep.repair(store.state, id)).toMatchObject({ item_id: tent, description: "zipper broken", state: "open" });
  expect(store.pending.at(-1)).toMatchObject({
    entity_type: "repair",
    type: "created",
    payload: { item_id: tent, description: "zipper broken" },
  });
  await expect(rep.raiseTicket(store, tent, "  ")).rejects.toThrow("say what is wrong");
  await expect(rep.raiseTicket(store, "nope", "x")).rejects.toThrow("no such item");
});

test("state moves by one field change with the old value kept (FR-REP-03)", async () => {
  const id = await rep.raiseTicket(store, tent, "zipper broken");
  await rep.setRepairState(store, id, "in_progress");
  expect(store.pending.at(-1)!.payload).toEqual({ field: "state", value: "in_progress", old: "open" });
  const before = store.pending.length;
  await rep.setRepairState(store, id, "in_progress");
  expect(store.pending).toHaveLength(before);
  await rep.setRepairState(store, id, "resolved");
  expect(rep.repair(store.state, id)?.state).toBe("resolved");
});

test("open means open or in progress; closed tickets stay on the item (FR-REP-04, FR-REP-05)", async () => {
  const a = await rep.raiseTicket(store, tent, "pole bent");
  const b = await rep.raiseTicket(store, tent, "zipper broken");
  const c = await rep.raiseTicket(store, tent, "peg missing");
  await rep.setRepairState(store, a, "resolved");
  await rep.setRepairState(store, b, "in_progress");
  await rep.setRepairState(store, c, "wont_fix");

  expect(rep.repairsFor(store.state, tent).map((r) => r.description)).toEqual([
    "zipper broken",
    "peg missing",
    "pole bent",
  ]);
  expect(rep.openRepairs(store.state, tent).map((r) => r.id)).toEqual([b]);
  expect(rep.openTickets(store.state).map((r) => r.id)).toEqual([b]);
  expect(rep.openRepairs(store.state, "other")).toEqual([]);
});

test("comments are notes on the ticket, and can be corrected (FR-REP-06)", async () => {
  const id = await rep.raiseTicket(store, tent, "zipper broken");
  const on = { entity_type: "repair", entity_id: id };
  const note = await notes.addNote(store, on, "slider ordered, $8");
  await notes.correctNote(store, on, note.id, "slider ordered, $12");
  expect(rep.repair(store.state, id)?.notes?.map((n) => n.text)).toEqual(["slider ordered, $12"]);
  await expect(notes.correctNote(store, on, "nope", "x")).rejects.toThrow("no such note");
  await expect(notes.addNote(store, { entity_type: "repair", entity_id: "nope" }, "x")).rejects.toThrow(
    "no such repair",
  );
});

test("the state labels read as a person says them", () => {
  expect(rep.REPAIR_STATES.map((s) => s.label)).toEqual(["Open", "In progress", "Resolved", "Won't fix"]);
  expect(rep.stateLabel("wont_fix")).toBe("Won't fix");
});

test("the history is every ticket raised or changed in a date range, last change first (FR-RPT-02)", async () => {
  // The clock starts at 1970-01-01; a day is 86,400,000 ms.
  const day = 86_400_000;
  clock = 10 * day; // 1970-01-10 in Vancouver
  const early = await rep.raiseTicket(store, tent, "pole bent");
  clock = 20 * day;
  const mid = await rep.raiseTicket(store, tent, "zipper broken");
  clock = 30 * day;
  await rep.setRepairState(store, early, "resolved"); // raised on the 10th, changed on the 30th
  clock = 40 * day;
  await rep.raiseTicket(store, tent, "peg missing");

  const ids = (from: string, to: string) => rep.repairHistory(store.state, from, to).map((r) => r.id);
  expect(ids("1970-01-25", "1970-01-31")).toEqual([early]);
  expect(ids("1970-01-15", "1970-01-31")).toEqual([early, mid]);
  expect(ids("1970-01-01", "1970-01-05")).toEqual([]);
  expect(ids("1970-01-01", "1970-02-28")).toHaveLength(3);
});
