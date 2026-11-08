import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { changes, describeValue, details, EVENT_TYPES } from "./audit";
import type { ServerEvent } from "./api";
import * as res from "./reservations";
import { alice, seedUsers } from "../ui/moveTestKit";
import { KNOWN_EVENT_TYPES } from "./replay";
import { openDb } from "./db";
import { Store } from "./store";

let store: Store;
let clock = 1_000;

beforeEach(async () => {
  clock = 1_000;
  store = await Store.open(await openDb("test", new IDBFactory()), () => clock++);
  await store.setMeta({ user: { id: "alice", name: "Alice", role: "admin", active: true } });
});

test("changes list the record's edits newest first, with names for ids (FR-USR-09)", async () => {
  const cold = await act.createLocation(store, "Cold locker");
  const warm = await act.createLocation(store, "Warm locker");
  const tent = await act.createItem(store, { name: "Tent", home_location_id: cold });
  await act.updateItem(store, tent, { home_location_id: warm });
  await act.retireItem(store, tent);

  const rows = changes(store, tent).map((c) => (c.kind === "created" ? c.label : `${c.label}: ${c.old} → ${c.new}`));
  expect(rows).toEqual(["Retired: — → Yes", "Home location: Cold locker → Warm locker", "Created"]);
  expect(changes(store, tent).every((c) => c.actor_id === "alice")).toBe(true);
});

test("a category change names the categories (FR-USR-09, FR-SET-07)", async () => {
  const tents = await act.createCategory(store, "Tents");
  const shelter = await act.createCategory(store, "Shelter");
  const tent = await act.createItem(store, { name: "Tent" });
  await act.updateItem(store, tent, { category_ids: [tents, shelter] });

  const rows = changes(store, tent).map((c) => (c.kind === "created" ? c.label : `${c.label}: ${c.old} → ${c.new}`));
  expect(rows).toEqual(["Categories: — → Shelter, Tents", "Created"]);
});

test("values read as a person would", async () => {
  const other = await act.createItem(store, { name: "Tent 2" });
  const tents = await act.createCategory(store, "Tents");
  const state = store.state;
  expect(describeValue(state, "name", null)).toBe("—");
  expect(describeValue(state, "retired", false)).toBe("No");
  expect(describeValue(state, "merged_into", other)).toBe("Tent 2");
  expect(describeValue(state, "parent_id", "nope")).toBe("(unknown item)");
  expect(describeValue(state, "sub_location", "shelf 4")).toBe("shelf 4");
  expect(describeValue(state, "category_ids", [tents])).toBe("Tents");
  expect(describeValue(state, "category_ids", [])).toBe("—");
  // price was dropped as a field (FR-INV-12); old events that changed it still read as dollars.
  expect(describeValue(state, "price", 249.99)).toBe("$249.99");
});

test("every event type the replay knows has a label in the filter", () => {
  const labelled = new Set(EVENT_TYPES.map((t) => t.value));
  const missing = [...KNOWN_EVENT_TYPES].filter((t) => !labelled.has(t));
  expect(missing).toEqual([]);
});

const T = 1_756_684_800_000;
const serverEvent = (over: Partial<ServerEvent>): ServerEvent => ({
  id: "e1",
  entity_type: "item",
  entity_id: "i1",
  type: "checked_out",
  actor_id: "alice",
  device_id: "phone-a",
  device_seq: 1,
  occurred_at: T,
  clock_offset: 0,
  effective_at: T,
  received_at: T,
  seq: 1,
  payload: {},
  ...over,
});

test("a field change reads as field, from and to", () => {
  const e = serverEvent({ type: "field_changed", payload: { field: "retired", old: false, value: true } });
  expect(details(store.state, e)).toEqual([
    { label: "Field", value: "Retired" },
    { label: "From", value: "No" },
    { label: "To", value: "Yes" },
    { label: "When", value: "2025-08-31 17:00" },
    { label: "Device", value: "phone-a" },
  ]);
});

test("a check-out names the holder and the reservation, and leaves out an empty reason", async () => {
  await seedUsers(store, [alice]);
  const camp = await res.createReservation(store, {
    event: "Spring camp",
    starts: "2026-04-10",
    ends: "2026-04-12",
    items: [],
    generics: [],
  });
  const e = serverEvent({
    payload: { holder_id: "alice", count: 3, event: "Fall camp", reservation_id: camp, reason: "" },
    received_at: T + 60_000,
  });
  const lines = details(store.state, e);
  expect(lines.slice(0, 4)).toEqual([
    { label: "Holder", value: "Alice" },
    { label: "Count", value: "3" },
    { label: "Event", value: "Fall camp" },
    { label: "Reservation", value: "Spring camp" },
  ]);
  expect(lines.map((d) => d.label)).toContain("Recorded");
  expect(lines.map((d) => d.label)).not.toContain("Reason");
});

test("a reservation with the event's own name is not said twice", async () => {
  const camp = await res.createReservation(store, {
    event: "Spring camp",
    starts: "2026-04-10",
    ends: "2026-04-12",
    items: [],
    generics: [],
  });
  const lines = details(store.state, serverEvent({ payload: { event: "Spring camp", reservation_id: camp } }));
  expect(lines.filter((d) => d.value === "Spring camp")).toHaveLength(1);
});

test("a reservation that is gone says so", () => {
  const lines = details(store.state, serverEvent({ payload: { reservation_id: "gone" } }));
  expect(lines[0]).toEqual({ label: "Reservation", value: "(deleted reservation)" });
});

test("a created item names its location and categories", async () => {
  const cold = await act.createLocation(store, "Cold locker");
  const tents = await act.createCategory(store, "Tents");
  const e = serverEvent({
    type: "created",
    payload: { name: "Tent", home_location_id: cold, category_ids: [tents] },
  });
  expect(details(store.state, e).slice(0, 3)).toEqual([
    { label: "Name", value: "Tent" },
    { label: "Home location", value: "Cold locker" },
    { label: "Categories", value: "Tents" },
  ]);
});

test("a corrected note shows one Note line and no ids", () => {
  const e = serverEvent({ type: "note_corrected", payload: { note_id: "n1", text: "Pole bent" } });
  expect(details(store.state, e).filter((d) => d.label === "Note")).toEqual([{ label: "Note", value: "Pole bent" }]);
  const ids = serverEvent({
    payload: { movement_id: "m1", note_id: "n1", photo_id: "p1", supersedes: "s1" },
  });
  expect(details(store.state, ids).map((d) => d.label)).toEqual(["When", "Device"]);
});

test("a photo's size reads in KB or MB", () => {
  const size = (n: number) => details(store.state, serverEvent({ type: "photo_added", payload: { size: n } }))[0];
  expect(size(830_000)).toEqual({ label: "Size", value: "830 KB" });
  expect(size(2_400_000)).toEqual({ label: "Size", value: "2.4 MB" });
});

test("a weighing reads as one weight, or unknown", () => {
  const w = (payload: Record<string, unknown>) => details(store.state, serverEvent({ type: "weighed", payload }))[0];
  expect(w({ value: 450, unit: "lb" })).toEqual({ label: "Weight", value: "450 lb" });
  expect(w({ value: null, unit: "lb" })).toEqual({ label: "Weight", value: "Unknown" });
});

test("a key the map does not know shows as it is", () => {
  const lines = details(store.state, serverEvent({ payload: { colour: "red", extra: { a: 1 } } }));
  expect(lines.slice(0, 2)).toEqual([
    { label: "colour", value: "red" },
    { label: "extra", value: '{"a":1}' },
  ]);
});
