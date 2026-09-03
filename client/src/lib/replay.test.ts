import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { replay, type ReplayEvent, type State, UnknownEventType } from "./replay";

interface Vector {
  name: string;
  events: ReplayEvent[];
  base?: State;
  state?: State;
  error?: string;
}

const dir = join(import.meta.dirname, "../../../vectors/replay/");
const vectors = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f, JSON.parse(readFileSync(dir + f, "utf8")) as Vector] as const);

describe("shared replay vectors", () => {
  test.each(vectors)("%s", (_file, vector) => {
    if (vector.error === "unknown_event_type") {
      expect(() => replay(vector.events)).toThrow(UnknownEventType);
    } else {
      expect(replay(vector.events, vector.base)).toStrictEqual(vector.state);
    }
  });

  test("there are vectors to run", () => {
    expect(vectors.length).toBeGreaterThan(5);
  });
});

test("replay does not change its base", () => {
  const base: State = { item: { t: { name: "Tent", status: "in", holder_id: null } } };
  const out: ReplayEvent = {
    id: "01000000000000000000000001",
    entity_type: "item",
    entity_id: "t",
    type: "checked_out",
    actor_id: "a",
    device_id: "d",
    device_seq: 1,
    effective_at: 5,
    payload: { holder_id: "bob" },
  };
  expect(replay([out], base).item?.t?.status).toBe("out");
  expect(base.item?.t?.status).toBe("in");
});

test("replay does not write on the lists an event's payload carries", () => {
  const made: ReplayEvent = {
    id: "01000000000000000000000001",
    entity_type: "reservation",
    entity_id: "r",
    type: "created",
    actor_id: "a",
    device_id: "d",
    device_seq: 1,
    effective_at: 1,
    payload: { event: "Fall Camp", items: ["tent-1"], generics: [{ item_id: "tarp", quantity: 1 }] },
  };
  const added: ReplayEvent = {
    ...made,
    id: "01000000000000000000000002",
    type: "item_added",
    device_seq: 2,
    effective_at: 2,
    payload: { item_id: "stove-1" },
  };
  const more: ReplayEvent = {
    ...made,
    id: "01000000000000000000000003",
    type: "quantity_changed",
    device_seq: 3,
    effective_at: 3,
    payload: { item_id: "tarp", quantity: 2 },
  };

  const state = replay([made, added, more]);
  expect(state.reservation?.r).toMatchObject({
    items: ["tent-1", "stove-1"],
    generics: [{ item_id: "tarp", quantity: 2 }],
  });
  // Replaying the same events again must give the same answer, so the payloads are untouched.
  expect(made.payload.items).toEqual(["tent-1"]);
  expect(made.payload.generics).toEqual([{ item_id: "tarp", quantity: 1 }]);
  expect(replay([made, added, more])).toEqual(state);
});

// --- pools (FR-INV-34) -----------------------------------------------------------------------
// vectors/replay/pool_*.json cover the headline cases; these are the edge cases that are
// awkward to spell out as fixed-state vectors.

function poolEvent(overrides: Partial<ReplayEvent>): ReplayEvent {
  return {
    id: "01000000000000000000000000",
    entity_type: "item",
    entity_id: "bowls",
    type: "created",
    actor_id: "alice",
    device_id: "a",
    device_seq: 1,
    effective_at: 1000,
    payload: {},
    ...overrides,
  };
}

test("a pool returning everything clears the holder", () => {
  const created = poolEvent({
    id: "01000000000000000000000001",
    payload: { generic: true, pool: true, quantity: 10 },
  });
  const out = poolEvent({
    id: "01000000000000000000000002",
    device_seq: 2,
    effective_at: 1001,
    type: "checked_out",
    payload: { holder_id: "bob", count: 4 },
  });
  const back = poolEvent({
    id: "01000000000000000000000003",
    device_seq: 3,
    effective_at: 1002,
    type: "checked_in",
    payload: { holder_id: "bob", count: 4 },
  });
  const bowls = replay([created, out, back]).item?.bowls;
  expect(bowls?.pool_out).toEqual({});
  expect(bowls?.pool_in).toBe(10);
});

test("a pool return with no holder defaults to whoever is returning it", () => {
  const created = poolEvent({
    id: "01000000000000000000000001",
    payload: { generic: true, pool: true, quantity: 10 },
  });
  const out = poolEvent({
    id: "01000000000000000000000002",
    actor_id: "bob",
    device_seq: 2,
    effective_at: 1001,
    type: "checked_out",
    payload: { holder_id: "bob", count: 4 },
  });
  const back = poolEvent({
    id: "01000000000000000000000003",
    actor_id: "bob",
    device_seq: 3,
    effective_at: 1002,
    type: "checked_in",
    payload: { count: 4 },
  });
  const bowls = replay([created, out, back]).item?.bowls;
  expect(bowls?.pool_out).toEqual({});
  expect((bowls?.movement as { holder_id: unknown } | undefined)?.holder_id).toBe("bob");
});

test("a pool has no conflict rule: counts from different devices just add (FR-OUT-24)", () => {
  const created = poolEvent({
    id: "01000000000000000000000001",
    payload: { generic: true, pool: true, quantity: 10 },
  });
  const a = poolEvent({
    id: "01000000000000000000000002",
    device_id: "a",
    device_seq: 2,
    effective_at: 1001,
    type: "checked_out",
    payload: { holder_id: "bob", count: 3 },
  });
  const b = poolEvent({
    id: "01000000000000000000000003",
    device_id: "b",
    device_seq: 1,
    effective_at: 1002,
    type: "checked_out",
    payload: { holder_id: "carol", count: 5 },
  });
  const bowls = replay([created, a, b]).item?.bowls;
  expect(bowls?.conflicts).toBeUndefined();
  expect(bowls?.pool_out).toEqual({ bob: 3, carol: 5 });
});
