import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test, vi } from "vitest";
import * as act from "./actions";
import { createApi, type ServerEvent } from "./api";
import { openDb } from "./db";
import { pendingPhotos, photosOf, queuePhoto, removePhoto, uploadPhotos } from "./photos";
import { Store } from "./store";

const T0 = 1_756_684_800_000;
const PHOTO = "01000000000000000000000AAA";

let store: Store;
let tent: string;
let clock: number;

beforeEach(async () => {
  clock = T0;
  store = await Store.open(await openDb("photos", new IDBFactory()), () => clock++);
  await store.setMeta({ token: "t", user: { id: "alice", name: "Alice", role: "user", active: true } });
  tent = await act.createItem(store, { name: "Tent 1" });
});

const on = () => ({ entity_type: "item", entity_id: tent });
const jpeg = (text = "not really a jpeg") => new Blob([text], { type: "image/jpeg" });

/** The server's answer to photo uploads, and a record of what it was sent. */
function fakeServer(status = 200) {
  const puts: { url: string; type: string | null; bytes: number }[] = [];
  let down = false;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (down) throw new TypeError("Failed to fetch");
    const url = new URL(String(input), "http://x");
    const headers = new Headers(init?.headers);
    const body = init?.body as Blob;
    puts.push({ url: url.pathname + url.search, type: headers.get("Content-Type"), bytes: body.size });
    return new Response(JSON.stringify({ error: "bad_request", message: "no", server_time: T0 }), { status });
  };
  return { puts, fetch, goDown: () => (down = true) };
}

test("a photo waits on the device with the entity it is for (FR-INV-11)", async () => {
  const id = await queuePhoto(store, on(), jpeg());
  const [waiting] = await pendingPhotos(store, on());
  expect(waiting).toMatchObject({ id, entity_type: "item", entity_id: tent, content_type: "image/jpeg" });
  expect(waiting!.bytes.byteLength).toBe(jpeg().size);
  expect(await pendingPhotos(store, { entity_type: "item", entity_id: "other" })).toEqual([]);
});

test("a photo needs an entity, a signed-in user, and an image type", async () => {
  await expect(queuePhoto(store, { entity_type: "item", entity_id: "nope" }, jpeg())).rejects.toThrow("no such item");
  await expect(queuePhoto(store, on(), new Blob(["x"], { type: "text/plain" }))).rejects.toThrow(/not a photo/);
  await store.setMeta({ user: undefined });
  await expect(queuePhoto(store, on(), jpeg())).rejects.toThrow("not signed in");
});

test("uploads go up oldest first as raw bytes, and leave the queue once the server has them", async () => {
  const server = fakeServer();
  const a = await queuePhoto(store, on(), jpeg("first"));
  const b = await queuePhoto(store, on(), jpeg("second, longer"));
  const api = createApi({ fetch: server.fetch, token: () => "t" });

  expect(await uploadPhotos(store, api)).toBe(2);
  expect(server.puts.map((p) => p.url)).toEqual([
    `/photos/${a}?entity_type=item&entity_id=${tent}`,
    `/photos/${b}?entity_type=item&entity_id=${tent}`,
  ]);
  expect(server.puts.map((p) => [p.type, p.bytes])).toEqual([
    ["image/jpeg", 5],
    ["image/jpeg", 14],
  ]);
  expect(await pendingPhotos(store)).toEqual([]);
});

test("offline stops the uploads and keeps every photo", async () => {
  const server = fakeServer();
  server.goDown();
  await queuePhoto(store, on(), jpeg());
  await queuePhoto(store, on(), jpeg());
  expect(await uploadPhotos(store, createApi({ fetch: server.fetch, token: () => "t" }))).toBe(0);
  expect((await pendingPhotos(store)).length).toBe(2);
});

test("a refused photo is dropped with a warning; sending it again would get the same answer", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const server = fakeServer(400);
  await queuePhoto(store, on(), jpeg());
  expect(await uploadPhotos(store, createApi({ fetch: server.fetch, token: () => "t" }))).toBe(1);
  expect(await pendingPhotos(store)).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/refused: no/));
  warn.mockRestore();
});

test("a retryable refusal (503) stops uploads and keeps the photo, unlike Offline it is still reported", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const server = fakeServer(503);
  await queuePhoto(store, on(), jpeg());
  expect(await uploadPhotos(store, createApi({ fetch: server.fetch, token: () => "t" }))).toBe(0);
  expect((await pendingPhotos(store)).length).toBe(1);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/will retry/));
  warn.mockRestore();
});

test("a 413 (too large) is dropped like any other refusal a retry cannot fix", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const server = fakeServer(413);
  await queuePhoto(store, on(), jpeg());
  expect(await uploadPhotos(store, createApi({ fetch: server.fetch, token: () => "t" }))).toBe(1);
  expect(await pendingPhotos(store)).toEqual([]);
  warn.mockRestore();
});

test("the server's record of a photo is read from state, and removing it is an event", async () => {
  const added: ServerEvent = {
    id: "01000000000000000000000009",
    entity_type: "item",
    entity_id: tent,
    type: "photo_added",
    actor_id: "alice",
    device_id: "server",
    device_seq: 1,
    occurred_at: T0 - 1000,
    clock_offset: 0,
    effective_at: T0 - 1000,
    received_at: T0,
    seq: 1,
    payload: { photo_id: PHOTO, content_type: "image/jpeg", size: 123 },
  };
  await store.receive([added], 1);
  expect(photosOf(store.state, on())).toEqual([
    { id: PHOTO, content_type: "image/jpeg", size: 123, actor_id: "alice", at: T0 - 1000 },
  ]);

  await expect(removePhoto(store, on(), "01000000000000000000000BBB")).rejects.toThrow("no such photo");
  await removePhoto(store, on(), PHOTO);
  expect(store.pending.at(-1)).toMatchObject({ type: "photo_removed", payload: { photo_id: PHOTO } });
  expect(photosOf(store.state, on())).toEqual([]);
});
