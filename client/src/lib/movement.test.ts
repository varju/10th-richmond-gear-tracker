import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import * as act from "./actions";
import { openDb } from "./db";
import { item, poolCounts, poolLots } from "./inventory";
import * as mv from "./movement";
import * as notes from "./notes";
import { createReservation, reservation, reservations, todayIso } from "./reservations";
import { afterMove, eventAsked, SESSION_MS, sessionEvent, setSessionEvent } from "./session";
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
  const out = await mv.checkOut(store, tent, { event: "Spring camp" });
  await notes.addNote(store, { entity_type: "item", entity_id: tent }, "to a patrol", out.id);
  expect(item(store.state, tent)).toMatchObject({ status: "out", holder_id: "alice" });
  expect(out.payload).toEqual({ holder_id: "alice", event: "Spring camp", reservation_id: expect.any(String) });

  const back = await mv.checkIn(store, tent);
  await notes.addNote(store, { entity_type: "item", entity_id: tent }, "muddy", back.id);
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
  const note = await notes.addNote(store, { entity_type: "item", entity_id: tent }, "handed to a Scout");
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
  expect(out.payload).toEqual({ holder_id: "alice", count: 6, event: "Fall Camp", reservation_id: expect.any(String) });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 14, pool_out: { alice: 6 } });

  await store.setMeta({ user: { id: "carol", name: "Carol", role: "user", active: true } });
  await mv.checkOutPool(store, bowls, { count: 3 });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 11, pool_out: { alice: 6, carol: 3 } });

  await mv.checkInPool(store, bowls, { count: 1 });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 12, pool_out: { alice: 6, carol: 2 } });

  await mv.checkOutPool(store, bowls, { count: 12 });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 0, pool_out: { alice: 6, carol: 14 } });

  await expect(mv.checkOutPool(store, tent, { count: 1 })).rejects.toThrow("not a pool");
  await expect(mv.checkOutPool(store, bowls, { count: 0 })).rejects.toThrow("at least 1");
});

test("a pool check-out of more than are in is refused (FR-OUT-55)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 5);
  await expect(mv.checkOutPool(store, bowls, { count: 6 })).rejects.toThrow("only 5 in");
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 5, pool_out: {} });
  await mv.checkOutPool(store, bowls, { count: 5 });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 0 });
});

test("a recount sets what is in right now, with or without a reason; what is out is untouched (FR-INV-35)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await mv.checkOutPool(store, bowls, { count: 5 });
  await mv.recount(store, bowls, 12, "counted on the shelf");
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 12, pool_out: { alice: 5 } });

  for (const blank of [undefined, "", " "]) {
    const none = await mv.recount(store, bowls, 9, blank);
    expect(none.payload).toEqual({ count: 9 });
  }
  await expect(mv.recount(store, bowls, -1, "why")).rejects.toThrow("zero or more");
  await expect(mv.recount(store, tent, 1, "why")).rejects.toThrow("not a pool");
});

test("marking a count missing takes it off the holder and keeps it owned; found puts it back (FR-INV-46, FR-INV-47)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await mv.checkOutPool(store, bowls, { count: 5 });
  const lost = await mv.markPoolMissing(store, bowls, { count: 2 });
  expect(lost.payload).toEqual({ count: 2 });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 15, pool_out: { alice: 3 }, pool_missing: 2 });
  expect(poolCounts(item(store.state, bowls)!)).toMatchObject({ owned: 20, in: 15, missing: 2 });

  const found = await mv.markPoolFound(store, bowls, 1);
  expect(found.payload).toEqual({ count: 1 });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 16, pool_out: { alice: 3 }, pool_missing: 1 });
});

test("a missing count for another holder names them, and a recount keeps owned honest (FR-INV-46, FR-INV-35)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await mv.checkOutPool(store, bowls, { count: 5 });
  await store.setMeta({ user: { id: "carol", name: "Carol", role: "user", active: true } });
  const lost = await mv.markPoolMissing(store, bowls, { holder_id: "alice", count: 5 });
  expect(lost.payload).toEqual({ count: 5, holder_id: "alice" });
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 15, pool_out: {}, pool_missing: 5 });

  await mv.recount(store, bowls, 10);
  expect(poolCounts(item(store.state, bowls)!)).toMatchObject({ owned: 15, in: 10, missing: 5, out: [] });
});

test("missing and found are refused for what the holder does not have, and for what is not missing", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await mv.checkOutPool(store, bowls, { count: 5 });
  await expect(mv.markPoolMissing(store, bowls, { count: 6 })).rejects.toThrow("only 5 out to alice");
  await expect(mv.markPoolMissing(store, bowls, { holder_id: "carol", count: 1 })).rejects.toThrow(
    "nothing out to carol",
  );
  await expect(mv.markPoolMissing(store, bowls, { count: 0 })).rejects.toThrow("at least 1");
  await expect(mv.markPoolMissing(store, bowls, { count: 1.5 })).rejects.toThrow("at least 1");
  await expect(mv.markPoolMissing(store, tent, { count: 1 })).rejects.toThrow("not a pool");
  await expect(mv.markPoolFound(store, bowls, 1)).rejects.toThrow("none of it is missing");
  await mv.markPoolMissing(store, bowls, { count: 2 });
  await expect(mv.markPoolFound(store, bowls, 3)).rejects.toThrow("only 2 missing");
  await expect(mv.markPoolFound(store, bowls, 0)).rejects.toThrow("at least 1");
  await expect(mv.markPoolFound(store, tent, 1)).rejects.toThrow("not a pool");
  expect(item(store.state, bowls)).toMatchObject({ pool_in: 15, pool_out: { alice: 3 }, pool_missing: 2 });
  expect(mv.history(store, bowls).map((e) => [e.type, e.count])).toEqual([
    ["pool_missing", 2],
    ["checked_out", 5],
  ]);
});

test("writing off missing gear drops it from owned, with an optional reason; refusals match found (FR-INV-49)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await expect(mv.writeOffPool(store, bowls, 1)).rejects.toThrow("none of it is missing");
  await mv.checkOutPool(store, bowls, { count: 5 });
  await mv.markPoolMissing(store, bowls, { count: 3 });
  await expect(mv.writeOffPool(store, bowls, 4)).rejects.toThrow("only 3 missing");
  await expect(mv.writeOffPool(store, bowls, 0)).rejects.toThrow("at least 1");
  await expect(mv.writeOffPool(store, tent, 1)).rejects.toThrow("not a pool");
  const off = await mv.writeOffPool(store, bowls, 2, " left at camp ");
  expect(off.payload).toEqual({ count: 2, reason: "left at camp" });
  expect((await mv.writeOffPool(store, bowls, 1, " ")).payload).toEqual({ count: 1 });
  expect(poolCounts(item(store.state, bowls)!)).toMatchObject({ owned: 17, in: 15, missing: 0 });
  expect(mv.history(store, bowls)[1]).toMatchObject({ type: "pool_written_off", count: 2, reason: "left at camp" });
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
  expect(sessionEvent(store.meta, at + 1)).toEqual({ waits: true });
  await mv.checkOut(store, tent, { event: "Fall camp" });
  expect(await storedSessionAt()).toBe(at);
  await setSessionEvent(store, "Spring camp", []);
  expect(store.meta.session_reservation_id).toBeUndefined();
  expect(sessionEvent(store.meta, store.now())).toEqual({ event: "Spring camp" });
});

test("setting the event trims it, and a change leaves earlier moves under theirs", async () => {
  await setSessionEvent(store, " Spring camp ", []);
  expect(store.meta.session_event).toBe("Spring camp");
  await mv.checkOut(store, tent, { event: "Spring camp" });
  await setSessionEvent(store, "Cub camp", []);
  expect(store.meta.session_event).toBe("Cub camp");
  expect(store.pending.filter((e) => e.type === "event_corrected")).toHaveLength(0);
  expect(item(store.state, tent)?.movement).toMatchObject({ event: "Spring camp" });
});

test("a cleaner is corrected by an appended record, and the old name stops being offered (FR-OUT-48, FR-OUT-50)", async () => {
  await mv.checkOut(store, tent);
  const first = await mv.sendItemHome(store, tent, { cleaner: "Smth" });
  const other = await act.createItem(store, { name: "Tent 2" });
  await mv.checkOut(store, other);
  await mv.sendItemHome(store, other, { cleaner: "Jones" });
  expect(mv.usedCleanerNames(store.known)).toEqual(["Jones", "Smth"]);

  await mv.correctCleaner(store, tent, first.id, "Smith");
  expect(item(store.state, tent)?.movement?.cleaner).toBe("Smith");
  expect(mv.history(store, tent)[0]?.cleaner).toBe("Smith");
  expect(mv.usedCleanerNames(store.known)).toEqual(["Smith", "Jones"]);
  await expect(mv.correctCleaner(store, tent, first.id, " ")).rejects.toThrow("say the corrected");
});

test("cleaner names are offered once each, case and spacing aside, newest first (FR-OUT-48)", async () => {
  const pool = await act.createPool(store, { name: "Bags" }, 20);
  await mv.checkOutPool(store, pool, { count: 3 });
  await mv.sendHomeFromPool(store, pool, { count: 1, cleaner: "Smith" });
  await mv.sendHomeFromPool(store, pool, { count: 1, cleaner: "Jones" });
  await mv.sendHomeFromPool(store, pool, { count: 1, cleaner: "  smith " });
  expect(mv.usedCleanerNames(store.known)).toEqual(["smith", "Jones"]);
});

test("names from stacks and single items sent home are offered, as their corrections read them (FR-OUT-48)", async () => {
  const pool = await act.createPool(store, { name: "Bags" }, 20);
  await mv.checkOutPool(store, pool, { count: 6 });
  const smth = await mv.sendHomeFromPool(store, pool, { count: 2, cleaner: "Smth" });
  await mv.sendHomeFromPool(store, pool, { count: 1, cleaner: "Jones" });
  await mv.checkOut(store, tent);
  await mv.sendItemHome(store, tent, { cleaner: "Lee" });
  expect(mv.usedCleanerNames(store.known)).toEqual(["Lee", "Jones", "Smth"]);

  await mv.correctCleaner(store, pool, smth.id, "Smith");
  expect(mv.usedCleanerNames(store.known)).toEqual(["Smith", "Lee", "Jones"]);
});

test("a pool return names whose share comes back (FR-OUT-47)", async () => {
  const pool = await act.createPool(store, { name: "Bags" }, 20);
  await mv.checkOutPool(store, pool, { count: 9 });
  await mv.sendHomeFromPool(store, pool, { count: 4, cleaner: "Smith" });
  await mv.sendHomeFromPool(store, pool, { count: 2, cleaner: "Jones" });
  await mv.checkInPool(store, pool, { count: 2, cleaner: "smith" });
  await mv.checkInPool(store, pool, { count: 1 });

  const lots = item(store.state, pool)!.pool_lots!.alice!;
  expect(lots.map((l) => [l.cleaner ?? null, l.count])).toEqual([
    [null, 2],
    ["Jones", 2],
    ["Smith", 2],
  ]);
});

test("a transfer of gear at a cleaner's home keeps the cleaner (FR-OUT-46)", async () => {
  await mv.checkOut(store, tent);
  await mv.sendItemHome(store, tent, { cleaner: "Smith" });
  await store.setMeta({ user: { id: "bob", name: "Bob", role: "user", active: true } });
  const moved = await mv.transfer(store, tent, { event: "Spring camp" });
  expect(moved.payload).not.toHaveProperty("cleaner");
  expect(item(store.state, tent)).toMatchObject({ holder_id: "bob", movement: { cleaner: "Smith", event: null } });
});

test("cleaned gear comes back to the Scouter, who still holds it (FR-OUT-51)", async () => {
  await expect(mv.backFromCleaning(store, tent)).rejects.toThrow("not sent home");
  await mv.checkOut(store, tent);
  await mv.sendItemHome(store, tent, { cleaner: "Smith" });
  await mv.backFromCleaning(store, tent);
  expect(item(store.state, tent)).toMatchObject({ status: "out", holder_id: "alice" });
  expect(item(store.state, tent)?.movement?.cleaner).toBeUndefined();
});

test("part of a family's share of a stack comes back; the counts do not move (FR-OUT-51)", async () => {
  const pool = await act.createPool(store, { name: "Bags" }, 20);
  await mv.checkOutPool(store, pool, { count: 6 });
  await mv.sendHomeFromPool(store, pool, { count: 4, cleaner: "Smith" });
  await mv.sendHomeFromPool(store, pool, { count: 2, cleaner: "Jones" });
  await expect(mv.backFromCleaning(store, pool, { cleaner: "Smith", count: 5 })).rejects.toThrow("only 4");
  await expect(mv.backFromCleaning(store, pool, { cleaner: "Nobody" })).rejects.toThrow();
  await mv.backFromCleaning(store, pool, { cleaner: " smith", count: 3 });

  const it = item(store.state, pool)!;
  expect(it.pool_out).toEqual({ alice: 6 });
  expect(it.pool_lots!.alice!.map((l) => [l.cleaner ?? null, l.count])).toEqual([
    ["Jones", 2],
    ["Smith", 1],
    [null, 3],
  ]);
});

test("cleaning ending shows in the history (FR-OUT-51)", async () => {
  await mv.checkOut(store, tent);
  await mv.sendItemHome(store, tent, { cleaner: "Smith" });
  await mv.backFromCleaning(store, tent);
  const [latest] = mv.history(store, tent);
  expect(latest?.type).toBe("cleaning_ended");
});

test("gear already out can be sent home, keeping the Scouter as holder (FR-OUT-46)", async () => {
  const out = await mv.checkOut(store, tent, { event: "Camp" });
  const since = item(store.state, tent)?.since;
  const sent = await mv.sendItemHome(store, tent, { cleaner: " Smith family " });
  expect(sent.type).toBe("cleaning_started");
  expect(sent.payload).toEqual({ cleaner: "Smith family", movement_id: out.id });
  expect(item(store.state, tent)).toMatchObject({ status: "out", holder_id: "alice", since });
  expect(item(store.state, tent)?.movement).toMatchObject({
    id: out.id,
    event: "Camp",
    cleaner: "Smith family",
    cleaning_id: sent.id,
  });
  expect(mv.history(store, tent)[0]).toMatchObject({ type: "cleaning_started", cleaner: "Smith family" });
  await expect(mv.sendItemHome(store, tent, { cleaner: "Jones" })).rejects.toThrow("already at someone");
  await expect(
    mv.sendItemHome(store, await act.createItem(store, { name: "Tent 2" }), { cleaner: "Jones" }),
  ).rejects.toThrow("not out");
  await mv.checkIn(store, tent);
  await mv.checkOut(store, tent);
  await expect(mv.sendItemHome(store, tent, { cleaner: " " })).rejects.toThrow("say who");
});

test("a send-home is renamed under its own id, and a plain check-out line never picks up the cleaner (FR-OUT-50)", async () => {
  const out = await mv.checkOut(store, tent);
  const sent = await mv.sendItemHome(store, tent, { cleaner: "Smth" });
  const movement = item(store.state, tent)!.movement!;
  await mv.correctCleaner(store, tent, movement.cleaning_id ?? movement.id, "Smith");
  expect(item(store.state, tent)?.movement?.cleaner).toBe("Smith");
  const lines = mv.history(store, tent);
  expect(lines.map((l) => [l.id, l.cleaner])).toEqual([
    [sent.id, "Smith"],
    [out.id, undefined],
  ]);
});

test("handing gear at a cleaner's home to another Scouter keeps its event and cleaner (FR-OUT-46)", async () => {
  await mv.checkOut(store, tent, { event: "Camp" });
  await mv.sendItemHome(store, tent, { cleaner: "Smith" });
  const moved = await mv.transfer(store, tent, { to: "bob" });
  expect(moved.payload).toMatchObject({ holder_id: "bob", event: "Camp" });
  expect(item(store.state, tent)?.movement).toMatchObject({ holder_id: "bob", event: "Camp", cleaner: "Smith" });
});

test("after a send-home and a transfer, the name is changed on the send-home, and every view reads it (FR-OUT-50)", async () => {
  await mv.checkOut(store, tent);
  const sent = await mv.sendItemHome(store, tent, { cleaner: "Smth" });
  await mv.transfer(store, tent, { to: "bob" });
  const movement = item(store.state, tent)!.movement!;
  expect(movement.cleaning_id).toBe(sent.id);

  await mv.correctCleaner(store, tent, movement.cleaning_id ?? movement.id, "Smith");
  expect(item(store.state, tent)?.movement?.cleaner).toBe("Smith");
  expect(mv.usedCleanerNames(store.known)).toEqual(["Smith"]);
  expect(mv.history(store, tent).find((l) => l.id === sent.id)?.cleaner).toBe("Smith");

  // A correction made offline against the send-home still applies after the transfer.
  await mv.correctCleaner(store, tent, sent.id, "Smyth");
  expect(item(store.state, tent)?.movement?.cleaner).toBe("Smyth");
});

test("a send-home for a check-out that has ended is ignored (FR-OUT-46)", async () => {
  const first = await mv.checkOut(store, tent);
  await mv.checkIn(store, tent);
  await store.setMeta({ user: { id: "bob", name: "Bob", role: "user", active: true } });
  await mv.checkOut(store, tent);
  await store.record({
    entity_type: "item",
    entity_id: tent,
    type: "cleaning_started",
    actor_id: "alice",
    payload: { cleaner: "Smith", movement_id: first.id },
  });
  expect(item(store.state, tent)?.movement?.cleaner).toBeUndefined();
});

test("part of a stack out at camp goes home, keeping its holder and event (FR-OUT-46)", async () => {
  const bags = await act.createPool(store, { name: "Bags" }, 20);
  await expect(mv.sendHomeFromPool(store, bags, { cleaner: "Smith", count: 1 })).rejects.toThrow("only 0");
  await mv.checkOutPool(store, bags, { count: 5, event: "Camp" });
  await expect(mv.sendHomeFromPool(store, bags, { cleaner: "Smith", count: 6 })).rejects.toThrow("only 5");
  await expect(mv.sendHomeFromPool(store, bags, { cleaner: " ", count: 1 })).rejects.toThrow("say who");

  const sent = await mv.sendHomeFromPool(store, bags, { cleaner: " Smith ", count: 3 });
  expect(sent.payload).toEqual({ cleaner: "Smith", count: 3 });
  const lots = poolLots(item(store.state, bags)!)[0]!.lots;
  expect(lots.map((l) => [l.count, l.cleaner ?? null, l.event])).toEqual([
    [2, null, "Camp"],
    [3, "Smith", "Camp"],
  ]);
  expect(poolCounts(item(store.state, bags)!)).toMatchObject({ in: 15, out: [{ holder_id: "alice", count: 5 }] });
  expect(mv.history(store, bags)[0]).toMatchObject({ type: "cleaning_started", count: 3, cleaner: "Smith" });
});

const carol = { id: "carol", name: "Carol", role: "user", active: true } as const;
const alice = { id: "alice", name: "Alice", role: "user", active: true } as const;

/** A store opened afresh on the same database, as after a restart. */
async function reopened() {
  return Store.open(await openDb("test", factory), () => clock++);
}

test("the first check-out moves at once with no event, starts the session, and waits for the answer (FR-OUT-05)", async () => {
  await store.setMeta({ session_event: "Spring camp", session_event_at: clock - SESSION_MS });
  const out = await mv.checkOut(store, tent, { waits: true });
  expect(out.payload).toEqual({ holder_id: "alice", event: null, reservation_id: null });
  expect(reservations(store.state)).toEqual([]);
  expect(store.meta).toMatchObject({ session_event_at: out.occurred_at, session_waiting: [out.id] });
  expect(sessionEvent(store.meta, store.now())).toEqual({ waits: true });

  const stove = await act.createItem(store, { name: "Stove" });
  const next = await mv.checkOut(store, stove, { waits: true });
  const restarted = await reopened();
  expect(restarted.meta).toMatchObject({ session_event_at: next.occurred_at, session_waiting: [out.id, next.id] });
  expect(mv.waitingMoves(restarted)).toEqual([
    { id: out.id, itemId: tent },
    { id: next.id, itemId: stove },
  ]);
  // Last used is still offered.
  expect(restarted.meta.session_event).toBe("Spring camp");
});

test("an answer relinks the waiting moves by id and joins the reservation's list; the session then uses it (FR-OUT-45, FR-RES-38)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  const out = await mv.checkOut(store, tent, { waits: true });
  const lot = await mv.checkOutPool(store, bowls, { count: 4, waits: true });

  await mv.answerEvent(store, " Cub camp ");
  const [made] = reservations(store.state);
  expect(made).toMatchObject({ event: "Cub camp", starts: todayIso(store.now()), items: [tent] });
  expect(made!.generics).toEqual([expect.objectContaining({ item_id: bowls, quantity: 4 })]);
  expect(store.pending.filter((e) => e.type === "event_corrected").map((e) => [e.entity_id, e.payload])).toEqual([
    [tent, { movement_id: out.id, event: "Cub camp", reservation_id: made!.id }],
    [bowls, { movement_id: lot.id, event: "Cub camp", reservation_id: made!.id }],
  ]);
  expect(item(store.state, tent)?.movement).toMatchObject({ event: "Cub camp", reservation_id: made!.id });
  expect(poolLots(item(store.state, bowls)!)[0]!.lots).toEqual([
    expect.objectContaining({ id: lot.id, event: "Cub camp", reservation_id: made!.id }),
  ]);
  expect(store.meta.session_waiting).toBeUndefined();
  expect(sessionEvent(store.meta, store.now())).toEqual({ event: "Cub camp" });
  expect(mv.waitingMoves(store)).toEqual([]);
});

test("an answer naming a planned event links the waiting moves to it (FR-OUT-45)", async () => {
  const today = todayIso(store.now());
  const fall = await createReservation(store, {
    event: "Fall Camp",
    starts: today,
    ends: today,
    items: [],
    generics: [],
  });
  await mv.checkOut(store, tent, { waits: true });
  await mv.answerEvent(store, "fall camp");
  expect(reservations(store.state).map((r) => r.id)).toEqual([fall]);
  expect(reservation(store.state, fall)?.items).toEqual([tent]);
  expect(item(store.state, tent)?.movement).toMatchObject({ reservation_id: fall });
});

test("No event answers without correcting anything", async () => {
  await mv.checkOut(store, tent, { waits: true });
  await mv.answerEvent(store, undefined);
  expect(store.pending.filter((e) => e.type === "event_corrected")).toEqual([]);
  expect(reservations(store.state)).toEqual([]);
  expect(mv.waitingMoves(store)).toEqual([]);
  expect(sessionEvent(store.meta, store.now())).toEqual({ event: undefined });
});

test("waiting moves lapse with the session; the next check-out starts a new list (FR-OUT-38, FR-OUT-57)", async () => {
  const out = await mv.checkOut(store, tent, { waits: true });
  clock += SESSION_MS;
  expect(mv.waitingMoves(store)).toEqual([]);
  await mv.answerEvent(store, "Cub camp");
  expect(store.pending.filter((e) => e.type === "event_corrected")).toEqual([]);

  await store.setMeta({ session_event_at: clock - SESSION_MS });
  const stove = await act.createItem(store, { name: "Stove" });
  const next = await mv.checkOut(store, stove, { waits: true });
  expect(store.meta.session_waiting).toEqual([next.id]);
  expect(item(store.state, tent)?.movement).toMatchObject({ id: out.id, event: null });
});

test("a waiting move since returned, or taken over on another phone, is dropped", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  const stove = await act.createItem(store, { name: "Stove" });
  await mv.checkOut(store, tent, { waits: true });
  const kept = await mv.checkOut(store, stove, { waits: true });
  await mv.checkOutPool(store, bowls, { count: 2, waits: true });
  await mv.checkIn(store, tent);
  await mv.checkInPool(store, bowls, { count: 2 });
  await store.receive(
    [
      {
        id: "0Z000000000000000000000001",
        entity_type: "item",
        entity_id: stove,
        type: "checked_out",
        actor_id: "carol",
        device_id: "carols-phone",
        device_seq: 1,
        occurred_at: clock,
        clock_offset: 0,
        effective_at: clock,
        received_at: clock,
        seq: 1,
        payload: { holder_id: "carol", event: null, reservation_id: null, supersedes: kept.id },
      },
    ],
    1,
  );
  expect(mv.waitingMoves(store)).toEqual([]);

  await mv.checkOut(store, tent, { waits: true });
  expect(mv.waitingMoves(store).map((m) => m.itemId)).toEqual([tent]);
  await mv.answerEvent(store, "Cub camp");
  expect(store.pending.filter((e) => e.type === "event_corrected").map((e) => e.entity_id)).toEqual([tent]);
  expect(item(store.state, stove)?.movement).toMatchObject({ holder_id: "carol", event: null });
});

test("a Give to on this phone waits in place of the move it replaces, and takes the answer", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  const out = await mv.checkOut(store, tent, { waits: true });
  const lent = await mv.checkOut(store, stove, { waits: true });
  const toBob = await mv.transfer(store, tent, { to: "bob", waits: true });
  const toCarol = await mv.transfer(store, stove, { to: "carol", waits: true });
  expect(toBob.payload).toMatchObject({ supersedes: out.id, event: null });
  expect(toCarol.payload).toMatchObject({ supersedes: lent.id, event: null });
  expect(store.meta.session_waiting).toEqual([toBob.id, toCarol.id]);
  expect((await reopened()).meta.session_waiting).toEqual([toBob.id, toCarol.id]);

  await mv.answerEvent(store, "Cub camp");
  const [cub] = reservations(store.state);
  expect(cub?.items).toEqual([tent, stove]);
  expect(item(store.state, tent)?.movement).toMatchObject({ id: toBob.id, event: "Cub camp", reservation_id: cub!.id });
  expect(item(store.state, stove)?.movement).toMatchObject({ id: toCarol.id, event: "Cub camp", holder_id: "carol" });
});

test("someone else signed in on the phone never sees or answers another person's waiting session", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  const out = await mv.checkOut(store, tent, { waits: true });
  expect(store.meta.session_waiting_user).toBe("alice");
  await store.setMeta({ user: carol });
  expect(eventAsked(store.meta, store.now())).toBe(false);
  expect(mv.waitingMoves(store)).toEqual([]);
  // Taking over Alice's tent keeps its event, and does not join her list.
  const taken = await mv.transfer(store, tent, { waits: true });
  expect(store.meta.session_waiting).toEqual([out.id]);
  // Carol's own first check-out starts her own waiting session; Alice's list is never answered by her.
  const mine = await mv.checkOut(store, stove, { waits: true });
  expect(store.meta).toMatchObject({ session_waiting: [mine.id], session_waiting_user: "carol" });
  await mv.answerEvent(store, "Cub camp");
  expect(store.pending.filter((e) => e.type === "event_corrected").map((e) => e.payload.movement_id)).toEqual([
    mine.id,
  ]);
  expect(item(store.state, tent)?.movement).toMatchObject({ id: taken.id, event: null });
});

test("the same person signed back in finds their waiting session as they left it", async () => {
  const out = await mv.checkOut(store, tent, { waits: true });
  await store.setMeta({ token: undefined, user: undefined });
  expect(mv.waitingMoves(store)).toEqual([]);
  await store.setMeta({ user: alice });
  expect(mv.waitingMoves(store)).toEqual([{ id: out.id, itemId: tent }]);
});

test("returning a waiting check-out takes it off the list; the last one off ends the session", async () => {
  await store.setMeta({ session_event: "Spring camp", session_event_at: clock - SESSION_MS });
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  const out = await mv.checkOut(store, tent, { waits: true });
  const lot = await mv.checkOutPool(store, bowls, { count: 3, waits: true });
  await mv.checkInPool(store, bowls, { count: 1 });
  expect(store.meta.session_waiting).toEqual([out.id, lot.id]);
  await mv.checkIn(store, tent);
  expect(store.meta.session_waiting).toEqual([lot.id]);
  await mv.checkInPool(store, bowls, { count: 2 });
  const after = await reopened();
  expect(after.meta.session_waiting).toBeUndefined();
  expect(after.meta.session_event_at).toBeUndefined();
  // Last used stays; the next check-out waits again rather than reading a stale answer.
  expect(after.meta.session_event).toBe("Spring camp");
  expect(sessionEvent(store.meta, store.now())).toEqual({ waits: true });
});

test("a waiting check-out corrected by hand leaves the list, so a later answer does not overwrite it", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  const out = await mv.checkOut(store, tent, { waits: true });
  const other = await mv.checkOut(store, stove, { waits: true });
  await mv.changeEvent(store, tent, "Scout camp");
  expect(store.meta.session_waiting).toEqual([other.id]);
  await mv.answerEvent(store, "Cub camp");
  expect(item(store.state, tent)?.movement).toMatchObject({ id: out.id, event: "Scout camp" });
  expect(item(store.state, stove)?.movement).toMatchObject({ event: "Cub camp" });
});

test("an answer that fails after a correction corrects no move twice, and joins it on retry", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  const first = await mv.checkOut(store, tent, { waits: true });
  const second = await mv.checkOut(store, stove, { waits: true });
  // Where an answer that failed between the first correction and its join leaves things.
  const cub = await createReservation(store, {
    event: "Cub camp",
    starts: todayIso(store.now()),
    ends: todayIso(store.now()),
    items: [],
    generics: [],
  });
  await mv.correctEvent(store, tent, first.id, "Cub camp", cub);
  expect(store.meta.session_waiting).toEqual([first.id, second.id]);

  await mv.answerEvent(store, "Cub camp");
  expect(store.pending.filter((e) => e.type === "event_corrected").map((e) => e.payload.movement_id)).toEqual([
    first.id,
    second.id,
  ]);
  expect(reservation(store.state, cub)?.items).toEqual([tent, stove]);
  expect(store.meta.session_waiting).toBeUndefined();
});

test("a waiting check-out from a tab that missed the answer takes it, and does not reopen the question", async () => {
  // This tab saw no session; another tab answered Cub camp since.
  const other = await reopened();
  await other.setMeta({ session_event: "Cub camp", session_event_at: clock });
  const out = await mv.checkOut(store, tent, { waits: true });
  expect(store.meta.session_waiting).toBeUndefined();
  expect(store.meta.session_event_at).toBe(out.occurred_at);
  expect(sessionEvent(store.meta, store.now())).toEqual({ event: "Cub camp" });
  const [cub] = reservations(store.state);
  expect(cub).toMatchObject({ event: "Cub camp", items: [tent] });
  expect(item(store.state, tent)?.movement).toMatchObject({ id: out.id, event: "Cub camp", reservation_id: cub!.id });
});

test("a waiting check-out into a session answered with No event stays with no event", async () => {
  await setSessionEvent(store, undefined, []);
  await mv.checkOut(store, tent, { waits: true });
  expect(store.meta.session_waiting).toBeUndefined();
  expect(store.pending.filter((e) => e.type === "event_corrected")).toEqual([]);
});

test("a take-over or transfer before the answer keeps the event and reservation the gear is out under (FR-OUT-56)", async () => {
  const out = await mv.checkOut(store, tent, { event: "Fall Camp", reservation_id: "r-fall" });
  await store.setMeta({ user: carol });
  const taken = await mv.transfer(store, tent, { waits: true });
  expect(taken.payload).toEqual({
    holder_id: "carol",
    event: "Fall Camp",
    reservation_id: "r-fall",
    supersedes: out.id,
  });
  const handed = await mv.transfer(store, tent, { to: "alice", waits: true });
  expect(handed.payload).toMatchObject({ holder_id: "alice", event: "Fall Camp", reservation_id: "r-fall" });
  expect(store.meta.session_waiting).toBeUndefined();
  expect(eventAsked(store.meta, store.now())).toBe(false);
});

test("a check-out made while an answer is being saved takes the answer too", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await mv.checkOut(store, tent, { waits: true });
  const answering = mv.answerEvent(store, "Cub camp");
  const late = await mv.checkOut(store, stove, { waits: true });
  expect(store.meta.session_waiting).toContain(late.id);
  await answering;
  expect(store.meta.session_waiting).toBeUndefined();
  expect(item(store.state, stove)?.movement).toMatchObject({ id: late.id, event: "Cub camp" });
  expect(reservations(store.state)[0]?.items).toEqual([tent, stove]);
});

test("saving an answer settles only the check-outs it answered", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  const first = await mv.checkOut(store, tent, { waits: true });
  const second = await mv.checkOut(store, stove, { waits: true });
  expect(await setSessionEvent(store, "Cub camp", [first.id])).toEqual([second.id]);
  expect((await reopened()).meta).toMatchObject({ session_event: "Cub camp", session_waiting: [second.id] });
  expect(sessionEvent(store.meta, store.now())).toEqual({ waits: true });
});

test("every part of a waiting pool lot split by sending some home takes the answer", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  const out = await mv.checkOutPool(store, bowls, { count: 6, waits: true });
  const home = await mv.sendHomeFromPool(store, bowls, { count: 4, cleaner: "Dana" });
  const back = await mv.backFromCleaning(store, bowls, { cleaner: "Dana", count: 1 });
  expect(store.meta.session_waiting).toEqual([out.id, home.id, back.id]);

  await mv.answerEvent(store, "Cub camp");
  const [cub] = reservations(store.state);
  const lots = poolLots(item(store.state, bowls)!)[0]!.lots;
  expect(lots.map((l) => [l.count, l.event, l.reservation_id])).toEqual([
    [2, "Cub camp", cub!.id],
    [3, "Cub camp", cub!.id],
    [1, "Cub camp", cub!.id],
  ]);
  // The three still at Dana's are not packed (FR-RES-36).
  expect(cub!.generics).toEqual([expect.objectContaining({ item_id: bowls, quantity: 3 })]);
  expect(store.meta.session_waiting).toBeUndefined();
});

test("a send-home of a whole waiting lot keeps it under its own id", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  const out = await mv.checkOutPool(store, bowls, { count: 2, waits: true });
  await mv.sendHomeFromPool(store, bowls, { count: 2, cleaner: "Dana" });
  expect(store.meta.session_waiting).toEqual([out.id]);
});

test("a transfer from a stale tab still waits in place of the move it replaces", () => {
  const read = { session_event: "Fall camp", session_event_at: 1_000, session_waiting: ["w", "x"] };
  expect(afterMove(read, { event: "Spring camp", supersedes: "w" }, "t", 2_000, undefined)).toEqual({
    ...read,
    session_waiting: ["t", "x"],
  });
  expect(afterMove(read, { event: "Spring camp", supersedes: "z" }, "t", 2_000, undefined)).toBeUndefined();
});
