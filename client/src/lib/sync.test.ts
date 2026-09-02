import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import { createApi, type ServerEvent } from "./api";
import { RETENTION_MS } from "./clock";
import { openDb } from "./db";
import { pendingPhotos, queuePhoto } from "./photos";
import { Store } from "./store";
import { sync } from "./sync";

const T0 = 1_756_684_800_000;

/** Enough of the server to drive sync. The real one is tested by its own suite. */
class FakeServer {
  events: ServerEvent[] = [];
  calls: string[] = [];
  serverTime = T0 + 60_000;
  gone = false;
  deactivated = false;
  down = false;
  pageSize = 2;

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError("Failed to fetch");
    const url = new URL(String(input), "http://x");
    this.calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const json = (status: number, body: object) =>
      new Response(JSON.stringify({ ...body, server_time: this.serverTime }), { status });
    const headers = new Headers(init?.headers);
    if (!headers.get("Authorization")?.startsWith("Bearer "))
      return json(401, { error: "unauthorized", message: "sign in first" });

    if (url.pathname === "/sync/push") {
      const body = JSON.parse(String(init?.body)) as { events: ServerEvent[] };
      const accepted: string[] = [];
      const rejected: { id: string; reason: string }[] = [];
      for (const e of body.events) {
        if (e.payload.text === "reject me") rejected.push({ id: e.id, reason: "not today" });
        else {
          this.events.push({
            ...e,
            seq: this.events.length + 1,
            effective_at: e.occurred_at + e.clock_offset,
            received_at: this.serverTime,
          });
          accepted.push(e.id);
        }
      }
      return json(200, { accepted, rejected });
    }
    if (this.deactivated) return json(403, { error: "deactivated", message: "this account has been deactivated" });
    if (url.pathname === "/sync/bootstrap") {
      return json(200, {
        snapshot: { item: { "tent-1": { name: "Tent", status: "in", holder_id: null } } },
        cursor: this.events.length,
      });
    }
    if (url.pathname.startsWith("/photos/") && init?.method === "PUT") {
      // The server keeps the file and writes the event itself; the device sees it on the next pull.
      const photo_id = url.pathname.slice("/photos/".length);
      this.events.push({
        id: `0100000000000000000000PH${String(this.events.length + 1).padStart(2, "0")}`,
        entity_type: url.searchParams.get("entity_type")!,
        entity_id: url.searchParams.get("entity_id")!,
        type: "photo_added",
        actor_id: "alice",
        device_id: "server",
        device_seq: this.events.length + 1,
        occurred_at: this.serverTime,
        clock_offset: 0,
        effective_at: this.serverTime,
        received_at: this.serverTime,
        seq: this.events.length + 1,
        payload: { photo_id, content_type: headers.get("Content-Type"), size: (init.body as Blob).size },
      });
      return json(200, {});
    }
    if (url.pathname === "/sync/pull") {
      if (this.gone) return json(410, { error: "re-bootstrap", message: "cursor is older than the retention window" });
      const since = Number(url.searchParams.get("since"));
      const page = this.events.filter((e) => e.seq > since).slice(0, this.pageSize);
      return json(200, { events: page, cursor: page.at(-1)?.seq ?? since });
    }
    return json(404, { error: "not_found", message: url.pathname });
  };
}

let server: FakeServer;
let store: Store;
let clock: number;

beforeEach(async () => {
  server = new FakeServer();
  clock = T0;
  store = await Store.open(await openDb("test", new IDBFactory()), () => clock);
  await store.setMeta({ token: "t" });
});

const api = () => createApi({ fetch: server.handle, now: () => clock, token: () => store.meta.token });

const record = (type = "note_added", payload: Record<string, unknown> = { text: "hi" }) =>
  store.record({ entity_type: "item", entity_id: "tent-1", type, actor_id: "alice", payload });

test("first run bootstraps, later runs pull in pages until empty", async () => {
  expect(await sync(store, api(), () => clock)).toEqual({ ok: true });
  expect(server.calls).toEqual(["GET /sync/bootstrap"]);
  expect(store.meta.cursor).toBe(0);
  expect(store.meta.clock_offset).toBe(60_000);
  expect(store.meta.last_sync_at).toBe(T0);

  for (let i = 1; i <= 3; i++) {
    server.events.push({
      id: `0100000000000000000000000${i}`,
      entity_type: "item",
      entity_id: "tent-1",
      type: "note_added",
      actor_id: "bob",
      device_id: "other",
      device_seq: i,
      occurred_at: T0,
      clock_offset: 0,
      effective_at: T0 + i,
      received_at: T0,
      seq: i,
      payload: { text: `n${i}` },
    });
  }
  server.calls = [];
  expect(await sync(store, api(), () => clock)).toEqual({ ok: true });
  expect(server.calls).toEqual(["GET /sync/pull?since=0", "GET /sync/pull?since=2", "GET /sync/pull?since=3"]);
  expect(store.meta.cursor).toBe(3);
  expect((store.items["tent-1"]?.notes as unknown[]).length).toBe(3);
});

test("pending work is pushed first, then comes back with a seq", async () => {
  await sync(store, api(), () => clock);
  const mine = await record();
  const bad = await record("note_added", { text: "reject me" });
  server.calls = [];

  expect(await sync(store, api(), () => clock)).toEqual({ ok: true });
  expect(server.calls[0]).toBe("POST /sync/push");
  expect(store.pending).toEqual([]);
  expect(store.meta.cursor).toBe(1);
  const notes = store.items["tent-1"]?.notes as { id: string }[];
  expect(notes.map((n) => n.id)).toEqual([mine.id]);
  expect(notes.map((n) => n.id)).not.toContain(bad.id);
});

test("offline leaves everything pending and says so", async () => {
  await record();
  server.down = true;
  expect(await sync(store, api(), () => clock)).toMatchObject({ ok: false, reason: "offline" });
  expect(store.pending.length).toBe(1);
  expect(store.meta.token).toBe("t");
});

test("a 410 on pull starts over from a snapshot", async () => {
  await sync(store, api(), () => clock);
  server.down = true;
  await record("checked_out", { holder_id: "carol" });
  expect(await sync(store, api(), () => clock)).toMatchObject({ reason: "offline" });

  server.down = false;
  server.gone = true;
  server.calls = [];
  expect(await sync(store, api(), () => clock)).toEqual({ ok: true });
  expect(server.calls).toEqual(["POST /sync/push", "GET /sync/pull?since=0", "GET /sync/bootstrap"]);
  expect(store.pending).toEqual([]);
  expect(store.meta.cursor).toBe(1);
});

test("a deactivated account gets its last push in, then is signed out", async () => {
  await sync(store, api(), () => clock);
  await record();
  server.deactivated = true;
  expect(await sync(store, api(), () => clock)).toMatchObject({ ok: false, reason: "signed_out" });
  expect(server.events.length).toBe(1);
  expect(store.pending).toEqual([]);
  expect(store.meta.token).toBeUndefined();
});

test("a 401 signs out", async () => {
  await store.setMeta({ token: "expired" });
  server.handle = async () =>
    new Response(JSON.stringify({ error: "unauthorized", message: "no", server_time: T0 }), { status: 401 });
  expect(await sync(store, api(), () => clock)).toMatchObject({ ok: false, reason: "signed_out" });
  expect(store.meta.token).toBeUndefined();
});

test("sync trims history past the retention window", async () => {
  await sync(store, api(), () => clock);
  server.events.push({
    id: "01000000000000000000000001",
    entity_type: "item",
    entity_id: "tent-1",
    type: "note_added",
    actor_id: "bob",
    device_id: "other",
    device_seq: 1,
    occurred_at: T0 - RETENTION_MS - 1,
    clock_offset: 0,
    effective_at: T0 - RETENTION_MS - 1,
    received_at: T0,
    seq: 1,
    payload: { text: "old" },
  });
  await sync(store, api(), () => clock);
  expect((store.items["tent-1"]?.notes as unknown[]).length).toBe(1);
  expect(await store.trim()).toBe(0);
});

test("a photo taken offline goes up at the next sync, and its event comes back (FR-INV-11)", async () => {
  await sync(store, api(), () => clock);
  await store.setMeta({ user: { id: "alice", name: "Alice", role: "user", active: true } });
  server.down = true;
  await queuePhoto(store, { entity_type: "item", entity_id: "tent-1" }, new Blob(["jpeg"], { type: "image/jpeg" }));
  expect(await sync(store, api(), () => clock)).toMatchObject({ reason: "offline" });
  expect((await pendingPhotos(store)).length).toBe(1);

  server.down = false;
  server.calls = [];
  expect(await sync(store, api(), () => clock)).toEqual({ ok: true });
  expect(server.calls[0]).toMatch(/^PUT \/photos\/[0-9A-Z]{26}\?entity_type=item&entity_id=tent-1$/);
  expect(await pendingPhotos(store)).toEqual([]);
  const photos = store.items["tent-1"]?.photos as { content_type: string; size: number }[];
  expect(photos).toEqual([expect.objectContaining({ content_type: "image/jpeg", size: 4 })]);
});
