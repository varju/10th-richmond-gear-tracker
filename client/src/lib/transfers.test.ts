import { expect, test } from "vitest";
import { DAY_MS, RETENTION_MS } from "./clock";
import type { ReplayEvent, State } from "./replay";
import { RECENT_TRANSFER_MS, transferChoices } from "./transfers";

const NOW = 1_000 * DAY_MS;

const state: State = {
  user: {
    alice: { name: "Alice", active: true },
    bob: { name: "Bob", active: true },
    carol: { name: "Carol", active: true },
    dave: { name: "Dave", active: true },
    erin: { name: "Erin", active: true },
    gone: { name: "Aaron", active: false },
  },
};

let n = 0;
function handed(actor: string, to: string, at: number, extra: Record<string, unknown> = {}): ReplayEvent {
  n += 1;
  return {
    id: `e${n}`,
    entity_type: "item",
    entity_id: "tent",
    type: "checked_out",
    actor_id: actor,
    device_id: "d",
    device_seq: n,
    effective_at: at,
    payload: { holder_id: to, supersedes: "prev", ...extra },
  };
}

const names = (list: { name: string }[]) => list.map((u) => u.name);

test("everyone but me, the holder, and inactive members, by name, when I have transferred to nobody", () => {
  expect(names(transferChoices(state, [], "alice", "bob", NOW))).toEqual(["Carol", "Dave", "Erin"]);
});

test("those I transferred to lately come first, most recent first, then the rest by name (FR-OUT-28)", () => {
  const events = [
    handed("alice", "erin", NOW - 10 * DAY_MS),
    handed("alice", "dave", NOW - 2 * DAY_MS),
    handed("alice", "erin", NOW - 20 * DAY_MS),
  ];
  expect(names(transferChoices(state, events, "alice", "bob", NOW))).toEqual(["Dave", "Erin", "Carol"]);
});

test("only my own transfers in the last three months count, and plain check-outs do not", () => {
  const events = [
    handed("bob", "erin", NOW - DAY_MS),
    handed("alice", "dave", NOW - 91 * DAY_MS),
    { ...handed("alice", "erin", NOW - DAY_MS), payload: { holder_id: "erin" } },
  ];
  expect(names(transferChoices(state, events, "alice", null, NOW))).toEqual(["Bob", "Carol", "Dave", "Erin"]);
});

test("the holder is left out even when I transferred to them lately", () => {
  const events = [handed("alice", "dave", NOW - DAY_MS)];
  expect(names(transferChoices(state, events, "alice", "dave", NOW))).toEqual(["Bob", "Carol", "Erin"]);
});

test("recent transfers look back no further than a device keeps history (NFR-DATA-03)", () => {
  expect(RECENT_TRANSFER_MS).toBeLessThanOrEqual(RETENTION_MS);
});
