import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import type { ServerEvent } from "./api";
import { hasOpenConflict, openConflicts, reviewConflict } from "./conflicts";
import { openDb } from "./db";
import * as mv from "./movement";
import { Store } from "./store";

// Two phones, offline, both check out one tent (FR-OFF-10). Replay queues it; this decides when it is settled.
let store: Store;
let clock = 1_000;
let tent: string;

beforeEach(async () => {
  clock = 1_000;
  store = await Store.open(await openDb("test", new IDBFactory()), () => clock++);
  await store.setMeta({ user: { id: "alice", name: "Alice", role: "user", active: true } });
  tent = await act.createItem(store, { name: "Tent" });
});

function checkout(id: string, device: string, seq: number, holder: string, at: number, event?: string): ServerEvent {
  return {
    id,
    entity_type: "item",
    entity_id: tent,
    type: "checked_out",
    actor_id: holder,
    device_id: device,
    device_seq: seq,
    occurred_at: at,
    clock_offset: 0,
    effective_at: at,
    received_at: at,
    seq,
    payload: { holder_id: holder, event: event ?? null },
  };
}

const bob = () => checkout("01000000000000000000000001", "phone-a", 1, "bob", 5_000, "Spring camp");
const carol = () => checkout("01000000000000000000000002", "phone-b", 1, "carol", 6_000);

test("two check-outs from different devices with no check-in between is open, later one first", async () => {
  await store.receive([carol(), bob()], 2);
  const open = openConflicts(store.state);
  expect(open).toHaveLength(1);
  expect(open[0]!.item.id).toBe(tent);
  expect(open[0]!.earlier.holder_id).toBe("bob");
  expect(open[0]!.later.holder_id).toBe("carol");
  expect(hasOpenConflict(store.state, tent)).toBe(true);
});

test("a check-in after the conflict closes it", async () => {
  await store.receive([bob(), carol()], 2);
  clock = 10_000; // after both check-outs, or replay would put the check-in first
  await mv.checkIn(store, tent);
  expect(openConflicts(store.state)).toEqual([]);
  expect(hasOpenConflict(store.state, tent)).toBe(false);
});

test("a transfer after the conflict closes it; a transfer is never a conflict itself (FR-OUT-12)", async () => {
  await store.receive([bob(), carol()], 2);
  clock = 10_000;
  await mv.transfer(store, tent);
  expect(openConflicts(store.state)).toEqual([]);
});

test("reviewing keeps the later holder and records one field change, then it is closed", async () => {
  await store.receive([bob(), carol()], 2);
  await reviewConflict(store, tent);
  expect(store.pending.at(-1)).toMatchObject({
    entity_type: "item",
    type: "field_changed",
    payload: { field: "reviewed_movement", value: "01000000000000000000000002", old: null },
  });
  expect(openConflicts(store.state)).toEqual([]);
  expect(store.state.item![tent]!.holder_id).toBe("carol");
  await expect(reviewConflict(store, tent)).rejects.toThrow("no open conflict");
});

test("a reviewed conflict reopens if the same two phones clash again", async () => {
  await store.receive([bob(), carol()], 2);
  await reviewConflict(store, tent);
  // Both phones check out again without a check-in: the earlier one is carol's, the later is a new one.
  await store.receive([checkout("01000000000000000000000003", "phone-a", 2, "bob", 7_000)], 3);
  const open = openConflicts(store.state);
  expect(open).toHaveLength(1);
  expect(open[0]!.later.id).toBe("01000000000000000000000003");
});

test("nothing open on an item with no conflicts, or none at all", () => {
  expect(openConflicts(store.state)).toEqual([]);
  expect(hasOpenConflict(store.state, tent)).toBe(false);
});
