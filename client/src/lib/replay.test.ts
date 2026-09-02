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
