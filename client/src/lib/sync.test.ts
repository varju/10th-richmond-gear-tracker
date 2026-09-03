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
  logId = "log-one";
  deactivated = false;
  down = false;
  pageSize = 2;
  lastSeq = new Map<string, number>();
  /** Bodies of every push this server has handled, in order (round_trip_ms among them). */
  pushBodies: { round_trip_ms?: number }[] = [];

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError("Failed to fetch");
    const url = new URL(String(input), "http://x");
    this.calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const json = (status: number, body: object) =>
      new Response(JSON.stringify({ log_id: this.logId, ...body, server_time: this.serverTime }), { status });
    const headers = new Headers(init?.headers);
    if (!headers.get("Authorization")?.startsWith("Bearer "))
      return json(401, { error: "unauthorized", message: "sign in first" });

    if (url.pathname === "/sync/push") {
      const body = JSON.parse(String(init?.body)) as { events: ServerEvent[]; round_trip_ms?: number };
      this.pushBodies.push({ round_trip_ms: body.round_trip_ms });
      const accepted: string[] = [];
      const rejected: { id: string | null; reason: string }[] = [];
      for (const e of body.events) {
        const last = this.lastSeq.get(e.device_id) ?? 0;
        if (e.payload.text === "reject me") rejected.push({ id: e.id, reason: "not today" });
        // The server could not tell whose record this was (no matching id it holds).
        else if (e.payload.text === "reject me unidentified") rejected.push({ id: null, reason: "not our event" });
        else if (e.device_seq <= last) {
          rejected.push({ id: e.id, reason: `device_seq ${e.device_seq} is not above the last seen, ${last}` });
        } else {
          this.events.push({
            ...e,
            seq: this.events.length + 1,
            effective_at: e.occurred_at + e.clock_offset,
            received_at: this.serverTime,
          });
          this.lastSeq.set(e.device_id, e.device_seq);
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
      const log = url.searchParams.get("log");
      if (log !== null && log !== this.logId)
        return json(410, { error: "re-bootstrap", message: "this is a different database" });
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
  expect(server.calls).toEqual([
    "GET /sync/pull?since=0&log=log-one",
    "GET /sync/pull?since=2&log=log-one",
    "GET /sync/pull?since=3&log=log-one",
  ]);
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

test("a device_seq collision (stale data sharing a device id) is re-stamped and pushed again", async () => {
  await sync(store, api(), () => clock);
  await store.setMeta({ device_id: "shared-device" });
  await record();
  await sync(store, api(), () => clock); // the server now has device_seq 1 for shared-device

  // A second copy of this device's data (leftover from before the fix, or a clone): its own
  // counter starts fresh, so the number it hands out collides with what the server already saw.
  const stale = await Store.open(await openDb("stale", new IDBFactory()), () => clock);
  const staleApi = createApi({ fetch: server.handle, now: () => clock, token: () => stale.meta.token });
  await stale.setMeta({ token: "t" });
  await sync(stale, staleApi, () => clock);
  await stale.setMeta({ device_id: "shared-device" });
  await stale.record({
    entity_type: "item",
    entity_id: "tent-1",
    type: "note_added",
    actor_id: "alice",
    payload: { text: "left behind" },
  });

  server.calls = [];
  expect(await sync(stale, staleApi, () => clock)).toEqual({ ok: true });
  expect(server.calls.filter((c) => c === "POST /sync/push").length).toBe(2);
  expect(stale.pending).toEqual([]);
  const notes = stale.items["tent-1"]?.notes as { text: string }[];
  expect(notes.map((n) => n.text)).toContain("left behind");
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
  expect(server.calls).toEqual(["POST /sync/push", "GET /sync/pull?since=0&log=log-one", "GET /sync/bootstrap"]);
  expect(store.pending).toEqual([]);
  expect(store.meta.cursor).toBe(1);
});

test("bootstrap stores which log the snapshot came from", async () => {
  await sync(store, api(), () => clock);
  expect(store.meta.log_id).toBe("log-one");
});

test("a cursor from another log starts over from a snapshot", async () => {
  await sync(store, api(), () => clock);
  await record("checked_out", { holder_id: "carol" });
  await sync(store, api(), () => clock);

  // The server database was replaced, and its new log has grown past our cursor.
  server.logId = "log-two";
  server.events = [];
  server.calls = [];
  expect(await sync(store, api(), () => clock)).toEqual({ ok: true });
  expect(server.calls).toEqual(["GET /sync/pull?since=1&log=log-one", "GET /sync/bootstrap"]);
  expect(store.meta.log_id).toBe("log-two");
  expect(store.meta.cursor).toBe(0);
  expect(store.items["tent-1"]?.name).toBe("Tent");
});

test("a cursor stored before log ids existed bootstraps instead of pulling", async () => {
  await sync(store, api(), () => clock);
  await store.setMeta({ log_id: undefined });
  server.calls = [];

  expect(await sync(store, api(), () => clock)).toEqual({ ok: true });
  expect(server.calls).toEqual(["GET /sync/bootstrap"]);
  expect(store.meta.log_id).toBe("log-one");
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

test("a 500 with no server_time (an unhandled error) yields no offset and never NaNs the clock", async () => {
  server.handle = async () => new Response(JSON.stringify({ detail: "x" }), { status: 500 });
  expect(await sync(store, api(), () => clock)).toMatchObject({ ok: false, reason: "error" });
  expect(store.meta.clock_offset).toBe(0);
});

test("a non-JSON 502 (a proxy's error page) is reported, not thrown past sync", async () => {
  server.handle = async () => new Response("<html>Bad Gateway</html>", { status: 502 });
  await expect(sync(store, api(), () => clock)).resolves.toMatchObject({ ok: false, reason: "error" });
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

test("a push sends the last measured round trip, and every response updates it for next time", async () => {
  expect(await sync(store, api(), () => clock)).toEqual({ ok: true });
  expect(store.meta.round_trip_ms).toBe(0);

  // Simulate this call taking 400ms of network time: the clock moves between sentAt and receivedAt.
  const realHandle = server.handle;
  server.handle = async (input: string | URL | Request, init?: RequestInit) => {
    clock += 400;
    return realHandle(input, init);
  };

  await record();
  server.pushBodies = [];
  expect(await sync(store, api(), () => clock)).toEqual({ ok: true });
  expect(server.pushBodies).toEqual([{ round_trip_ms: 0 }]); // what bootstrap had measured, sent up front
  expect(store.meta.round_trip_ms).toBe(400); // this sync's own measurement, ready for next time

  await record();
  server.pushBodies = [];
  await sync(store, api(), () => clock);
  expect(server.pushBodies).toEqual([{ round_trip_ms: 400 }]);
});

test("a push reply carrying a different log_id bootstraps instead of pulling", async () => {
  expect(await sync(store, api(), () => clock)).toEqual({ ok: true });
  await record();
  server.logId = "log-two"; // the server's database was replaced since we last synced
  server.calls = [];

  expect(await sync(store, api(), () => clock)).toEqual({ ok: true });
  expect(server.calls).toEqual(["POST /sync/push", "GET /sync/bootstrap"]);
  expect(store.meta.log_id).toBe("log-two");
  expect(store.pending).toEqual([]); // marked pushed as usual before bootstrapping
});

test("a pull page that does not advance the cursor is a server bug, and is not swallowed", async () => {
  await sync(store, api(), () => clock);
  server.handle = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/sync/pull") {
      return new Response(
        JSON.stringify({
          events: [
            {
              id: "01000000000000000000000BUG",
              entity_type: "item",
              entity_id: "tent-1",
              type: "note_added",
              actor_id: "bob",
              device_id: "other",
              device_seq: 1,
              occurred_at: T0,
              clock_offset: 0,
              effective_at: T0,
              received_at: T0,
              seq: 0,
              payload: { text: "stuck" },
            },
          ],
          cursor: 0,
          log_id: "log-one",
          server_time: T0,
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: "not_found", message: url.pathname, server_time: T0 }), {
      status: 404,
    });
  };
  await expect(sync(store, api(), () => clock)).rejects.toThrow(/cursor/);
});

test("a rejection the server could not identify surfaces as an unclean sync, but the rest still runs", async () => {
  await sync(store, api(), () => clock);
  await record("note_added", { text: "reject me unidentified" });

  const outcome = await sync(store, api(), () => clock);
  expect(outcome).toEqual({
    ok: false,
    reason: "error",
    message: "the server refused 1 record(s) it could not identify",
  });
  expect(store.meta.last_sync_at).toBe(clock); // pull still ran; the device is not stuck
});
