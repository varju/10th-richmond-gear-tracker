import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test, vi } from "vitest";
import type { ServerEvent } from "./api";
import { RETENTION_MS } from "./clock";
import { openDb } from "./db";
import { replay, type ReplayEvent } from "./replay";
import { Store } from "./store";

const T0 = 1_756_684_800_000;
let factory: IDBFactory;
let clock: number;

beforeEach(() => {
  factory = new IDBFactory();
  clock = T0;
});

const open = async () => Store.open(await openDb("test", factory), () => clock);

const tent = (store: Store, type: string, payload: Record<string, unknown>) =>
  store.record({ entity_type: "item", entity_id: "tent-1", type, actor_id: "alice", payload });

/**
 * The fastest of several rounds of two operations, run interleaved. A GC pause or scheduler
 * hiccup can only add time, never remove it, so the minimum approaches the true cost; running
 * `a` and `b` back to back each round (rather than all of `a` then all of `b`) keeps a hiccup
 * from landing entirely inside one side's block and skewing the comparison.
 */
async function fastestOf(
  times: number,
  a: () => Promise<unknown>,
  b: () => Promise<unknown>,
): Promise<[number, number]> {
  let bestA = Infinity;
  let bestB = Infinity;
  for (let i = 0; i < times; i++) {
    const startA = performance.now();
    await a();
    bestA = Math.min(bestA, performance.now() - startA);
    const startB = performance.now();
    await b();
    bestB = Math.min(bestB, performance.now() - startB);
  }
  return [bestA, bestB];
}

function fromServer(e: Partial<ServerEvent> & { seq: number }): ServerEvent {
  return {
    id: `0100000000000000000000${String(e.seq).padStart(4, "0")}`,
    entity_type: "item",
    entity_id: "tent-1",
    type: "created",
    actor_id: "bob",
    device_id: "other",
    device_seq: e.seq,
    occurred_at: T0,
    clock_offset: 0,
    effective_at: T0,
    received_at: T0,
    payload: { name: "Tent" },
    ...e,
  };
}

test("a fresh store makes itself a device id and keeps it", async () => {
  const first = await open();
  expect(first.meta.device_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  const second = await open();
  expect(second.meta.device_id).toBe(first.meta.device_id);
});

test("recording stamps the clock offset and climbs device_seq", async () => {
  const store = await open();
  await store.setMeta({ clock_offset: 5_000 });
  const a = await tent(store, "created", { name: "Tent" });
  clock += 10;
  const b = await tent(store, "checked_out", { holder_id: "bob" });

  expect([a.device_seq, b.device_seq]).toEqual([1, 2]);
  expect(a.occurred_at).toBe(T0);
  expect(a.effective_at).toBe(T0 + 5_000);
  expect(a.clock_offset).toBe(5_000);
  expect(store.pending.map((e) => e.id)).toEqual([a.id, b.id]);
  expect(store.items["tent-1"]).toMatchObject({ name: "Tent", status: "out", holder_id: "bob" });
});

test("device_seq survives a restart", async () => {
  const store = await open();
  await tent(store, "created", { name: "Tent" });
  const again = await open();
  const next = await tent(again, "field_changed", { field: "name", value: "Big tent", old: "Tent" });
  expect(next.device_seq).toBe(2);
  expect(again.items["tent-1"]?.name).toBe("Big tent");
});

test("two tabs of the same device never hand out the same device_seq", async () => {
  const db = await openDb("test", factory);
  const tabA = await Store.open(db, () => clock);
  const tabB = await Store.open(db, () => clock);

  // Recording alternately, as two tabs racing would: each reads the counter fresh, in IndexedDB,
  // not the stale copy the other tab is holding in memory.
  const a1 = await tent(tabA, "created", { name: "Tent" });
  const b1 = await tent(tabB, "note_added", { text: "seen in the yard" });
  const a2 = await tent(tabA, "field_changed", { field: "name", value: "Big tent", old: "Tent" });
  const b2 = await tent(tabB, "note_added", { text: "still there" });

  const seqs = [a1.device_seq, b1.device_seq, a2.device_seq, b2.device_seq];
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).toEqual([1, 2, 3, 4]);
});

test("what goes to the server is exactly what it validates", async () => {
  const store = await open();
  const event = await tent(store, "created", { name: "Tent" });
  expect(Object.keys(Store.outgoing(event)).sort()).toEqual(
    [
      "actor_id",
      "clock_offset",
      "device_id",
      "device_seq",
      "entity_id",
      "entity_type",
      "id",
      "occurred_at",
      "payload",
      "type",
    ].sort(),
  );
});

test("a push answer settles each event; the unmentioned stay pending", async () => {
  const store = await open();
  const a = await tent(store, "created", { name: "Tent" });
  const b = await tent(store, "field_changed", { field: "name", value: "X", old: "Tent" });
  const c = await tent(store, "note_added", { text: "torn" });
  await store.pushed([a.id], [{ id: b.id, reason: "no" }]);

  expect(store.pending.map((e) => e.id)).toEqual([c.id]);
  expect(store.items["tent-1"]?.name).toBe("Tent");
  expect((store.items["tent-1"]?.notes as unknown[]).length).toBe(1);
});

test("a device_seq collision is re-stamped, not rejected, and asks for a retry", async () => {
  const store = await open();
  const a = await tent(store, "created", { name: "Tent" });
  const b = await tent(store, "note_added", { text: "torn" });

  const result = await store.pushed(
    [],
    [
      { id: a.id, reason: "device_seq 1 is not above the last seen, 4" },
      { id: b.id, reason: "device_seq 2 is not above the last seen, 4" },
    ],
  );

  expect(result).toEqual({ retry: true, unidentified: 0 });
  expect(store.pending.map((e) => e.device_seq)).toEqual([5, 6]);
  expect(store.pending.every((e) => e.sent === "no")).toBe(true);
  // The stored counter moved on too, so the next fresh record does not collide either.
  expect((await tent(store, "note_added", { text: "another" })).device_seq).toBe(7);
});

test("an ordinary rejection is unaffected by the collision handling", async () => {
  const store = await open();
  const a = await tent(store, "created", { name: "Tent" });
  const b = await tent(store, "note_added", { text: "hi" });
  const result = await store.pushed([a.id], [{ id: b.id, reason: "not today" }]);

  expect(result).toEqual({ retry: false, unidentified: 0 });
  expect(store.pending).toEqual([]);
  expect(store.state.item?.["tent-1"]?.name).toBe("Tent");
});

test("setMeta guards a non-finite clock_offset, storing 0 instead", async () => {
  const store = await open();
  await store.setMeta({ clock_offset: NaN });
  expect(store.meta.clock_offset).toBe(0);
  const reopened = await open();
  expect(reopened.meta.clock_offset).toBe(0);
});

test("setMeta treats an undefined clock_offset (a sign-in with no offset to measure) as 0, not a deleted key", async () => {
  const store = await open();
  await store.setMeta({ clock_offset: 5_000 });
  await store.setMeta({ clock_offset: undefined });
  expect(store.meta.clock_offset).toBe(0);
  expect("clock_offset" in store.meta).toBe(true);
});

test("an event of a type this build does not know is skipped, not thrown, and the store still opens", async () => {
  const store = await open();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await store.receive(
    [
      fromServer({ seq: 1 }),
      fromServer({ seq: 2, type: "future_thing", device_seq: 2, payload: { whatever: true } }),
      fromServer({
        seq: 3,
        type: "field_changed",
        device_seq: 3,
        payload: { field: "name", value: "Big tent", old: "Tent" },
      }),
    ],
    3,
  );
  expect(store.items["tent-1"]?.name).toBe("Big tent");
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();

  const reopened = await open();
  expect(reopened.items["tent-1"]?.name).toBe("Big tent");
});

test("bootstrap writes the snapshot, cursor, and log_id together", async () => {
  const store = await open();
  await store.bootstrap({ item: { "tent-1": { name: "Tent" } } }, 5, "log-one");
  expect(store.meta.cursor).toBe(5);
  expect(store.meta.log_id).toBe("log-one");
  expect(store.items["tent-1"]?.name).toBe("Tent");

  const reopened = await open();
  expect(reopened.meta.cursor).toBe(5);
  expect(reopened.meta.log_id).toBe("log-one");
  expect(reopened.items["tent-1"]?.name).toBe("Tent");
});

test("bootstrap replaces sent history and keeps unsent work on top", async () => {
  const store = await open();
  await store.receive([fromServer({ seq: 1 })], 1);
  const mine = await tent(store, "checked_out", { holder_id: "carol" });

  await store.bootstrap({ item: { "tent-1": { name: "Tent", status: "in", holder_id: null } } }, 7);

  expect(store.meta.cursor).toBe(7);
  expect(store.pending.map((e) => e.id)).toEqual([mine.id]);
  expect(store.items["tent-1"]).toMatchObject({ status: "out", holder_id: "carol" });
  const reopened = await open();
  expect(reopened.items["tent-1"]?.holder_id).toBe("carol");
});

test("the server's copy of our event replaces ours", async () => {
  const store = await open();
  const mine = await tent(store, "created", { name: "Tent" });
  await store.pushed([mine.id], []);
  await store.receive([fromServer({ ...Store.outgoing(mine), seq: 9, effective_at: T0 - 50, received_at: T0 })], 9);

  expect(store.pending).toEqual([]);
  expect(store.items["tent-1"]?.name).toBe("Tent");
  const reopened = await open();
  expect(reopened.meta.cursor).toBe(9);
});

test("trim folds old sent events into the snapshot and never an unsent one", async () => {
  const store = await open();
  const old = T0 - RETENTION_MS - 10;
  await store.receive(
    [
      fromServer({ seq: 1, effective_at: old }),
      fromServer({ seq: 2, effective_at: old + 1, type: "checked_out", device_seq: 2, payload: { holder_id: "bob" } }),
      fromServer({ seq: 3, effective_at: T0 - 10, type: "checked_in", device_seq: 3, payload: {} }),
    ],
    3,
  );
  clock = old + 5;
  const stale = await tent(store, "note_added", { text: "left behind" });
  clock = T0;

  const before = structuredClone(store.state);
  expect(await store.trim()).toBe(2);
  expect(store.state).toStrictEqual(before);
  expect(store.pending.map((e) => e.id)).toEqual([stale.id]);

  const reopened = await open();
  expect(reopened.state).toStrictEqual(before);
  expect(await reopened.trim()).toBe(0);
});

test("pushed counts a rejection with no id, or matching nothing stored, as unidentified", async () => {
  const store = await open();
  const a = await tent(store, "created", { name: "Tent" });
  const result = await store.pushed(
    [],
    [
      { id: null, reason: "could not read that as an object" },
      { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "no such event" },
      { id: a.id, reason: "not today" },
    ],
  );

  expect(result).toEqual({ retry: false, unidentified: 2 });
  expect(store.pending).toEqual([]);
  expect(store.rejected.map((e) => e.id)).toEqual([a.id]);
});

test("incremental apply matches a full replay through a mix of record, receive, and pushed", async () => {
  const store = await open();
  // Mirrors what the store should consider live: every event handed to record/receive, minus
  // anything later rejected. The store's own `state` is checked against a full replay of this
  // after every step, so an incremental apply that gave a wrong answer would show up at once.
  const known = new Map<string, ReplayEvent>();
  const track = (e: ReplayEvent) => known.set(e.id, e);
  const parity = () => expect(store.state).toStrictEqual(replay(known.values()));

  clock = T0;
  const tentCreated = await tent(store, "created", { name: "Tent" });
  track(tentCreated);
  clock = T0 + 100;
  track(
    await store.record({
      entity_type: "item",
      entity_id: "pool-1",
      type: "created",
      actor_id: "alice",
      payload: { generic: true, pool: true, name: "Rope (30m)", quantity: 20 },
    }),
  );
  clock = T0 + 200;
  track(
    await store.record({
      entity_type: "item",
      entity_id: "pool-1",
      type: "checked_out",
      actor_id: "alice",
      payload: { holder_id: "bob", count: 5, event: "camp" },
    }),
  );
  parity();

  // A pulled event older than everything applied so far: lands in the middle of history,
  // so this cannot be folded in incrementally.
  const kettleCreated = fromServer({
    seq: 1,
    entity_id: "kettle-1",
    effective_at: T0 + 50,
    device_id: "other",
    device_seq: 1,
    payload: { name: "Kettle" },
  });
  await store.receive([kettleCreated], 1);
  track(kettleCreated);
  parity();

  // Ordinary local record after a pulled batch: sorts after everything known, so this one is
  // the incremental case the pulled batch above was not.
  clock = T0 + 300;
  track(await tent(store, "field_changed", { field: "name", value: "Big tent", old: "Tent" }));
  parity();

  // A pulled batch mixing a genuinely new event with the server's own copy of an event this
  // device already recorded and had applied (a clamped effective_at, same id): the replacement
  // alone rules out incremental apply for the whole batch.
  const echoedTent = fromServer({
    ...Store.outgoing(tentCreated),
    seq: 2,
    effective_at: T0 - 10,
    received_at: T0 + 300,
  });
  const kettleRenamed = fromServer({
    seq: 3,
    entity_id: "kettle-1",
    type: "field_changed",
    effective_at: T0 + 400,
    device_id: "other",
    device_seq: 2,
    payload: { field: "name", value: "Big kettle", old: "Kettle" },
  });
  await store.receive([echoedTent, kettleRenamed], 3);
  track(echoedTent);
  track(kettleRenamed);
  parity();

  // A reservation, a quantity_changed line, and a movement to correct.
  clock = T0 + 500;
  track(
    await store.record({
      entity_type: "reservation",
      entity_id: "res-1",
      type: "created",
      actor_id: "alice",
      payload: { event: "Camp", starts: "2026-09-10", ends: "2026-09-12", items: [], generics: [] },
    }),
  );
  clock = T0 + 600;
  track(
    await store.record({
      entity_type: "reservation",
      entity_id: "res-1",
      type: "quantity_changed",
      actor_id: "alice",
      payload: { item_id: "pool-1", quantity: 3 },
    }),
  );
  parity();

  clock = T0 + 700;
  const checkedOut = await tent(store, "checked_out", { holder_id: "carol" });
  track(checkedOut);
  clock = T0 + 800;
  track(
    await store.record({
      entity_type: "item",
      entity_id: "tent-1",
      type: "event_corrected",
      actor_id: "alice",
      payload: { movement_id: checkedOut.id, event: "Camp" },
    }),
  );
  parity();

  // A rejection drops an event out of the live set: only a full recompute can account for that.
  clock = T0 + 900;
  const badNote = await tent(store, "note_added", { text: "lost strap" });
  track(badNote);
  parity();
  const result = await store.pushed([], [{ id: badNote.id, reason: "blocked" }]);
  expect(result.unidentified).toBe(0);
  known.delete(badNote.id);
  parity();

  // A receive whose events are older than a still-pending local one: the pending record must
  // not be skipped over just because the pulled batch could not be applied incrementally.
  clock = T0 + 1000;
  track(await tent(store, "note_added", { text: "pending note" }));
  const oldKettleUpdate = fromServer({
    seq: 4,
    entity_id: "kettle-1",
    type: "field_changed",
    effective_at: T0 + 150,
    device_id: "other",
    device_seq: 3,
    payload: { field: "name", value: "Old kettle update", old: "Big kettle" },
  });
  await store.receive([oldKettleUpdate], 4);
  track(oldKettleUpdate);
  parity();

  // And once more, an ordinary record after that pulled batch: back to the incremental case.
  clock = T0 + 1100;
  track(await tent(store, "note_added", { text: "final" }));
  parity();
});

test("incremental apply stays fast once there is real history behind it", async () => {
  const store = await open();
  const COUNT = 20_000;
  const bulk: ServerEvent[] = [];
  for (let i = 0; i < COUNT; i++) {
    bulk.push(
      fromServer({
        seq: i + 1,
        entity_id: `item-${i % 500}`,
        type: i % 7 === 0 ? "field_changed" : "created",
        device_id: "bulk",
        device_seq: i + 1,
        effective_at: T0 + i,
        payload: i % 7 === 0 ? { field: "name", value: `Item ${i}`, old: "" } : { name: `Item ${i}` },
      }),
    );
  }
  await store.receive(bulk, COUNT);
  const first = bulk[0];
  if (!first) throw new Error("test setup: expected a bulk event");

  clock = T0 + COUNT + 10;
  // discard() always falls back to a full rebuild, so it stands in for what the incremental
  // record above would have cost without it. Deleting an id already gone still forces the same
  // rebuild, so calling it repeatedly on `first.id` is fine.
  const [incremental, full] = await fastestOf(
    8,
    () => tent(store, "created", { name: "Tent" }),
    () => store.discard(first.id),
  );

  console.log(
    `over ${COUNT} events: incremental record ${incremental.toFixed(2)}ms, full rebuild ${full.toFixed(2)}ms`,
  );
  expect(incremental).toBeLessThan(full);
}, 20_000);

test("a role change on the server reaches this device on the next sync", async () => {
  const store = await open();
  await store.setMeta({ token: "t", user: { id: "bea", name: "Bea", role: "user", active: true } });
  expect(store.admin).toBe(false);

  await store.receive(
    [
      fromServer({
        seq: 1,
        entity_type: "user",
        entity_id: "bea",
        type: "created",
        payload: { name: "Bea", role: "admin", active: true },
      }),
    ],
    1,
  );
  expect(store.admin).toBe(true);

  // And back down, without waiting for a sign-out: meta.user still says "admin" here.
  await store.receive(
    [
      fromServer({
        seq: 2,
        entity_type: "user",
        entity_id: "bea",
        type: "field_changed",
        device_seq: 2,
        payload: { field: "role", value: "user", old: "admin" },
      }),
    ],
    2,
  );
  expect(store.admin).toBe(false);
});
