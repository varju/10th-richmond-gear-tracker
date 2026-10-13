import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { openDb } from "./db";
import { item } from "./inventory";
import * as mv from "./movement";
import { eventAsked, SESSION_MS, sessionEvent, setSessionEvent } from "./session";
import { Store } from "./store";

let store: Store;
let factory: IDBFactory;
let clock = 1_000;
let tent: string;

beforeEach(async () => {
  clock = 1_000;
  factory = new IDBFactory();
  store = await Store.open(await openDb("test", factory), () => clock++);
  await store.setMeta({ user: { id: "alice", name: "Alice", role: "user", active: true } });
  tent = await act.createItem(store, { name: "Tent" });
});

/** The session clock as stored, read afresh as a new tab would. */
async function storedSessionAt() {
  return (await Store.open(await openDb("test", factory), () => clock)).meta.session_event_at;
}

test("check out, then in, with the session event and a note on each", async () => {
  const out = await mv.checkOut(store, tent, { event: "Spring camp", note: "to a patrol" });
  expect(item(store.state, tent)).toMatchObject({ status: "out", holder_id: "alice" });
  expect(out.payload).toEqual({ holder_id: "alice", event: "Spring camp", reservation_id: null });

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

test("a check-out that names a reservation carries it on the movement (FR-RES-13)", async () => {
  await mv.checkOut(store, tent, { event: "Fall Camp", reservation_id: "r-fall" });
  expect(item(store.state, tent)?.movement).toMatchObject({ event: "Fall Camp", reservation_id: "r-fall" });
});

test("a transfer names the check-out it replaces", async () => {
  const first = await mv.checkOut(store, tent);
  await store.setMeta({ user: { id: "carol", name: "Carol", role: "user", active: true } });
  const taken = await mv.transfer(store, tent);
  expect(taken.payload).toMatchObject({ holder_id: "carol", supersedes: first.id });
  expect(item(store.state, tent)?.holder_id).toBe("carol");
  expect(item(store.state, tent)?.conflicts).toBeUndefined();
});

test("a transfer can name another member; the actor stays whoever tapped (FR-OUT-26)", async () => {
  const first = await mv.checkOut(store, tent);
  const handed = await mv.transfer(store, tent, { to: "carol" });
  expect(handed.actor_id).toBe("alice");
  expect(handed.payload).toMatchObject({ holder_id: "carol", supersedes: first.id });
  expect(item(store.state, tent)?.holder_id).toBe("carol");
  await expect(mv.transfer(store, tent, { to: "carol" })).rejects.toThrow("already have it");
});

test("a transfer carries the reservation it packs, like a check-out (FR-RES-22)", async () => {
  await mv.checkOut(store, tent, { event: "Spring Camp" });
  await store.setMeta({ user: { id: "carol", name: "Carol", role: "user", active: true } });
  await mv.transfer(store, tent, { event: "Fall Camp", reservation_id: "r-fall" });
  expect(item(store.state, tent)?.movement).toMatchObject({ event: "Fall Camp", reservation_id: "r-fall" });
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

test("a check-in clears missing (FR-INV-19)", async () => {
  await mv.checkOut(store, tent);
  await act.markMissing(store, tent);
  expect(item(store.state, tent)).toMatchObject({ status: "out", missing: true });
  await mv.checkIn(store, tent);
  expect(item(store.state, tent)).toMatchObject({ status: "in", missing: false });
  expect(store.pending.slice(-2).map((e) => [e.type, e.payload])).toEqual([
    ["checked_in", {}],
    ["field_changed", { field: "missing", value: false, old: true }],
  ]);
});

test("a merged duplicate's movements join the survivor's history, and it cannot move itself (FR-INV-13)", async () => {
  await mv.checkOut(store, tent, { event: "Spring camp" });
  await mv.checkIn(store, tent);
  const other = await act.createItem(store, { name: "Tent (again)" });
  await mv.checkOut(store, other, { event: "Cub camp" });
  await mv.checkIn(store, other);
  await store.setMeta({ user: { id: "alice", name: "Alice", role: "admin", active: true } });
  await act.mergeItem(store, tent, other);

  expect(mv.history(store, other).map((e) => [e.type, e.event])).toEqual([
    ["checked_in", null],
    ["checked_out", "Cub camp"],
    ["checked_in", null],
    ["checked_out", "Spring camp"],
  ]);
  await expect(mv.checkOut(store, tent)).rejects.toThrow("merged");
});

test("a pool moves by count: several people can have some out at once (FR-OUT-22, FR-OUT-24)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  const out = await mv.checkOutPool(store, bowls, { count: 6, event: "Fall Camp" });
  expect(out.payload).toEqual({ holder_id: "alice", count: 6, event: "Fall Camp", reservation_id: null });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 14, pool_out: { alice: 6 } });

  await store.setMeta({ user: { id: "carol", name: "Carol", role: "user", active: true } });
  await mv.checkOutPool(store, bowls, { count: 3 });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 11, pool_out: { alice: 6, carol: 3 } });

  await mv.checkInPool(store, bowls, { count: 1 });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 12, pool_out: { alice: 6, carol: 2 } });

  // Never blocked; the count still records, clamped at zero (FR-OUT-22).
  await mv.checkOutPool(store, bowls, { count: 50 });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 0, pool_out: { alice: 6, carol: 52 } });

  await expect(mv.checkOutPool(store, tent, { count: 1 })).rejects.toThrow("not a pool");
  await expect(mv.checkOutPool(store, bowls, { count: 0 })).rejects.toThrow("at least 1");
});

test("a recount sets what is in right now, with a reason; what is out is untouched (FR-INV-35)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await mv.checkOutPool(store, bowls, { count: 5 });
  await mv.recount(store, bowls, 12, "counted on the shelf");
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 12, pool_out: { alice: 5 } });

  await expect(mv.recount(store, bowls, 12, " ")).rejects.toThrow("say why");
  await expect(mv.recount(store, bowls, -1, "why")).rejects.toThrow("zero or more");
  await expect(mv.recount(store, tent, 1, "why")).rejects.toThrow("not a pool");
});

test("returning more than a holder has out is refused, and so is returning nothing (FR-OUT-23)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await mv.checkOutPool(store, bowls, { count: 5 });
  await expect(mv.checkInPool(store, bowls, { count: 6 })).rejects.toThrow("only 5 out to alice");
  await expect(mv.checkInPool(store, bowls, { holder_id: "carol", count: 1 })).rejects.toThrow("nothing out to carol");
  // Refused before anything is written.
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 15, pool_out: { alice: 5 } });
});

test("anyone can return another's, named by holder_id in the payload (FR-OUT-23)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await mv.checkOutPool(store, bowls, { count: 5 });
  await store.setMeta({ user: { id: "carol", name: "Carol", role: "user", active: true } });
  await mv.checkOutPool(store, bowls, { count: 3 });

  const back = await mv.checkInPool(store, bowls, { holder_id: "alice", count: 2 });
  expect(back.payload).toEqual({ count: 2, holder_id: "alice" });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 14, pool_out: { alice: 3, carol: 3 } });

  // Returning your own is not named in the payload.
  const own = await mv.checkInPool(store, bowls, { count: 1 });
  expect(own.payload).toEqual({ count: 1 });
  expect(item(store.state, bowls)).toMatchObject({ pool_out: { alice: 3, carol: 2 } });
});

test("history carries a pool's counts, checked-out, checked-in and recounted lines alike (FR-INV-34, FR-INV-35)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await mv.checkOutPool(store, bowls, { count: 6, event: "Fall Camp" });
  await mv.checkInPool(store, bowls, { count: 2 });
  await mv.recount(store, bowls, 15, "counted on the shelf");
  expect(mv.history(store, bowls).map((e) => [e.type, e.count, e.reason])).toEqual([
    ["recounted", 15, "counted on the shelf"],
    ["checked_in", 2, null],
    ["checked_out", 6, null],
  ]);
});

test("a move in a running session keeps it going, in the same write; an ended one stays ended (FR-OUT-38)", async () => {
  await store.setMeta({ session_event: "Spring camp", session_event_at: clock });
  const out = await mv.checkOut(store, tent, { event: "Spring camp" });
  expect(store.meta.session_event_at).toBe(out.occurred_at);
  expect(await storedSessionAt()).toBe(out.occurred_at);

  const back = await mv.checkIn(store, tent);
  expect(await storedSessionAt()).toBe(back.occurred_at);

  const ended = clock - SESSION_MS;
  await store.setMeta({ session_event_at: ended });
  await mv.checkOut(store, tent, { event: "Spring camp" });
  expect(store.meta.session_event_at).toBe(ended);
});

test("packing and a recount leave the plain session's clock alone (FR-OUT-38, FR-RES-25)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await store.setMeta({ session_event: "Spring camp", session_event_at: clock });
  const at = store.meta.session_event_at;
  await mv.checkOut(store, tent, { event: "Fall camp", reservation_id: "r1", packing: true });
  await mv.checkIn(store, tent, { packing: true });
  await mv.checkOutPool(store, bowls, { count: 2, event: "Fall camp", reservation_id: "r1", packing: true });
  await mv.recount(store, bowls, 15, "counted on the shelf");
  expect(store.meta.session_event_at).toBe(at);
  expect(await storedSessionAt()).toBe(at);
});

test("the session is judged from what is stored, not this tab's copy (FR-OUT-38)", async () => {
  await store.setMeta({ session_event: "Spring camp", session_event_at: clock });
  const other = await Store.open(await openDb("test", factory), () => clock);

  // Ended in another tab: it stays ended, and this tab learns so.
  const ended = clock - SESSION_MS;
  await other.setMeta({ session_event_at: ended });
  await mv.checkOut(store, tent, { event: "Spring camp" });
  expect(await storedSessionAt()).toBe(ended);
  expect(store.meta.session_event_at).toBe(ended);

  // Changed in another tab: a move stamped with the old event does not keep the new one going.
  await other.setMeta({ session_event: "Fall camp", session_event_at: clock });
  const changed = other.meta.session_event_at;
  await mv.transfer(store, tent, { to: "bob", event: "Spring camp" });
  expect(await storedSessionAt()).toBe(changed);
  expect(store.meta).toMatchObject({ session_event: "Fall camp", session_event_at: changed });
});

test("a packing link left by an older build is not a plain session: a move does not keep it going (FR-RES-25)", async () => {
  await store.setMeta({ session_event: "Fall camp", session_event_at: clock, session_reservation_id: "r1" });
  const at = store.meta.session_event_at!;
  expect(eventAsked(store.meta, at + 1)).toBe(false);
  expect(sessionEvent(store.meta, at + 1)).toEqual({});
  await mv.checkOut(store, tent, { event: "Fall camp" });
  expect(await storedSessionAt()).toBe(at);
  await setSessionEvent(store, "Spring camp");
  expect(store.meta.session_reservation_id).toBeUndefined();
  expect(sessionEvent(store.meta, store.now())).toEqual({ event: "Spring camp" });
});
