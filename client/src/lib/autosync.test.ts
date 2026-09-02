import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { autoSync } from "./autosync";
import { openDb } from "./db";
import { Store } from "./store";
import type { SyncOutcome } from "./sync";

const T0 = 1_756_684_800_000;
const timing = { flushMs: 5, retryMs: [20, 40] };

let store: Store;
let stop: () => void = () => {};
let outcomes: SyncOutcome[];
let runs: number[];

beforeEach(async () => {
  store = await Store.open(await openDb("test", new IDBFactory()), () => T0);
  outcomes = [];
  runs = [];
});

afterEach(() => stop());

const ok: SyncOutcome = { ok: true };
const offline: SyncOutcome = { ok: false, reason: "offline", message: "no network" };

/** A sync that records when it ran, answers from `outcomes`, and marks everything sent on success. */
async function run(): Promise<SyncOutcome> {
  runs.push(Date.now());
  const outcome = outcomes.shift() ?? ok;
  if (outcome.ok)
    await store.pushed(
      store.pending.map((e) => e.id),
      [],
    );
  return outcome;
}

const note = (text: string) =>
  store.record({ entity_type: "item", entity_id: "a", type: "note_added", actor_id: "u1", payload: { text } });

const settle = () => new Promise((r) => setTimeout(r, 15));

test("a record is pushed as soon as it is made; several in a row share one push", async () => {
  stop = autoSync(store, run, timing);
  await settle();
  expect(runs).toHaveLength(0);

  await note("a");
  await note("b");
  await note("c");
  await settle();
  expect(runs).toHaveLength(1);
  expect(store.pending).toHaveLength(0);
});

test("a failed sync backs off, then keeps the records until a sync succeeds", async () => {
  outcomes = [offline, offline];
  stop = autoSync(store, run, timing);
  await note("a");
  await vi.waitFor(() => expect(runs).toHaveLength(3), { timeout: 500 });

  expect(runs[1]! - runs[0]!).toBeGreaterThanOrEqual(18);
  expect(runs[2]! - runs[1]!).toBeGreaterThanOrEqual(38);
  expect(store.pending).toHaveLength(0);
});

test("the network coming back cuts the wait short", async () => {
  outcomes = [offline, offline, offline, offline];
  stop = autoSync(store, run, timing);
  await note("a");
  await vi.waitFor(() => expect(runs).toHaveLength(3), { timeout: 500 });
  // Now waiting the long delay. Going online resets it.
  outcomes = [];
  window.dispatchEvent(new Event("online"));
  await settle();
  expect(runs).toHaveLength(4);
  expect(store.pending).toHaveLength(0);
});

test("signed out means wait for a sign-in, not a retry", async () => {
  outcomes = [{ ok: false, reason: "signed_out", message: "not signed in" }];
  stop = autoSync(store, run, timing);
  await note("a");
  await new Promise((r) => setTimeout(r, 80));
  expect(runs).toHaveLength(1);
  expect(store.pending).toHaveLength(1);
});

test("a sync already in flight is looked at again, not doubled", async () => {
  let busy = true;
  const shared = async () => (busy ? undefined : run());
  stop = autoSync(store, shared, timing);
  await note("a");
  await settle();
  expect(runs).toHaveLength(0);
  busy = false;
  await settle();
  expect(runs).toHaveLength(1);
});

test("stopping unhooks it", async () => {
  stop = autoSync(store, run, timing);
  stop();
  await note("a");
  await settle();
  expect(runs).toHaveLength(0);
});
