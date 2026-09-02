import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import type { ServerEvent } from "./api";
import { RETENTION_MS } from "./clock";
import { openDb } from "./db";
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
