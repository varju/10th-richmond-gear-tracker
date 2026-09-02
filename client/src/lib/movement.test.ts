import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { openDb } from "./db";
import { item } from "./inventory";
import * as mv from "./movement";
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

test("check out, then in, with the session event and a note on each", async () => {
  const out = await mv.checkOut(store, tent, { event: "Spring camp", note: "to a patrol" });
  expect(item(store.state, tent)).toMatchObject({ status: "out", holder_id: "alice" });
  expect(out.payload).toEqual({ holder_id: "alice", event: "Spring camp" });

  await mv.checkIn(store, tent, { note: "muddy" });
  expect(item(store.state, tent)).toMatchObject({ status: "in", holder_id: null });

  const h = mv.history(store, tent);
  expect(h.map((e) => [e.type, e.event, e.notes.map((n) => n.text)])).toEqual([
    ["checked_in", null, ["muddy"]],
    ["checked_out", "Spring camp", ["to a patrol"]],
  ]);
});

test("an empty event is null, not an empty string", async () => {
  const out = await mv.checkOut(store, tent, { event: "  " });
  expect(out.payload.event).toBeNull();
});

test("a transfer names the check-out it replaces", async () => {
  const first = await mv.checkOut(store, tent);
  await store.setMeta({ user: { id: "carol", name: "Carol", role: "user", active: true } });
  const taken = await mv.transfer(store, tent);
  expect(taken.payload).toMatchObject({ holder_id: "carol", supersedes: first.id });
  expect(item(store.state, tent)?.holder_id).toBe("carol");
  expect(item(store.state, tent)?.conflicts).toBeUndefined();
});

test("the wrong direction is refused, and so is retired gear", async () => {
  await expect(mv.checkIn(store, tent)).rejects.toThrow("already in");
  await expect(mv.transfer(store, tent)).rejects.toThrow("not out");
  await mv.checkOut(store, tent);
  await expect(mv.checkOut(store, tent)).rejects.toThrow("already out");
  await mv.checkIn(store, tent);
  await act.retireItem(store, tent);
  await expect(mv.checkOut(store, tent)).rejects.toThrow("retired");
});

test("a note is corrected by appending; the item shows the new text", async () => {
  const note = await mv.addNote(store, tent, "handed to a Scout");
  await mv.correctNote(store, tent, note.id, "handed to a Scout for the weekend");
  expect(item(store.state, tent)?.notes).toEqual([
    { id: note.id, text: "handed to a Scout for the weekend", actor_id: "alice", at: note.effective_at },
  ]);
  expect(store.pending.map((e) => e.type)).toEqual(["created", "note_added", "note_corrected"]);
  await expect(mv.correctNote(store, tent, "nope", "x")).rejects.toThrow("no such note");
});

test("history excludes rejected events and is newest first", async () => {
  const a = await mv.checkOut(store, tent);
  await mv.checkIn(store, tent);
  const b = await mv.checkOut(store, tent);
  await store.pushed([], [{ id: b.id, reason: "no" }]);
  expect(mv.history(store, tent).map((e) => e.id)).not.toContain(b.id);
  expect(mv.history(store, tent).at(-1)?.id).toBe(a.id);
});
