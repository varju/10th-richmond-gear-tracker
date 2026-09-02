import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { openDb } from "./db";
import * as mv from "./movement";
import * as notes from "./notes";
import { Store } from "./store";
import { timeline } from "./timeline";

let store: Store;
let clock = 1_000;
let tent: string;

beforeEach(async () => {
  clock = 1_000;
  store = await Store.open(await openDb("test", new IDBFactory()), () => clock++);
  await store.setMeta({ user: { id: "alice", name: "Alice", role: "user", active: true } });
  tent = await act.createItem(store, { name: "Tent" });
});

test("movements and notes come back as one list, newest first", async () => {
  await notes.addNote(store, { entity_type: "item", entity_id: tent }, "Fly is patched");
  await mv.checkOut(store, tent, { note: "took the repair kit too" });
  await mv.checkIn(store, tent);

  expect(timeline(store, tent).map((e) => [e.kind, e.kind === "note" ? e.note.text : e.movement.type])).toEqual([
    ["movement", "checked_in"],
    ["movement", "checked_out"],
    ["note", "Fly is patched"],
  ]);
});

test("a note made on a movement rides with it rather than standing alone", async () => {
  await mv.checkOut(store, tent, { note: "took the repair kit too" });
  const entries = timeline(store, tent);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.kind === "movement" && entries[0]!.movement.notes.map((n) => n.text)).toEqual([
    "took the repair kit too",
  ]);
});
