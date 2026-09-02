import { beforeEach, expect, test } from "vitest";
import { openStore } from "../ui/codeTestKit";
import type { ServerEvent } from "./api";
import { foundFor, foundReports, resolveFound } from "./found";
import type { Store } from "./store";

// Found reports come from the server, never from a phone (FR-PUB-02). A member only resolves them (FR-PUB-03).
const T0 = 1_756_684_800_000;
let store: Store;

/** A report as the server writes it: actor public, device server. */
function reported(id: string, note: string, item_id: string | null, at: number): ServerEvent {
  return {
    id,
    entity_type: "found_report",
    entity_id: id,
    type: "created",
    actor_id: "public",
    device_id: "server",
    device_seq: at,
    occurred_at: at,
    clock_offset: 0,
    effective_at: at,
    received_at: at,
    seq: at,
    payload: { code: "AAAAAAAAAA", item_id, note, contact: "finder@example.org" },
  };
}

beforeEach(async () => {
  store = await openStore();
  await store.receive(
    [
      reported("01000000000000000000000001", "by the gate", "tent", T0 + 1),
      reported("01000000000000000000000002", "in the car park", "tent", T0 + 2),
      reported("01000000000000000000000003", "no sticker on anything yet", null, T0 + 3),
    ],
    3,
  );
});

test("unresolved reports, newest first", () => {
  expect(foundReports(store.state).map((r) => r.note)).toEqual([
    "no sticker on anything yet",
    "in the car park",
    "by the gate",
  ]);
  expect(foundFor(store.state, "tent").map((r) => r.note)).toEqual(["in the car park", "by the gate"]);
  expect(foundReports(store.state)[0]).toMatchObject({
    code: "AAAAAAAAAA",
    item_id: null,
    contact: "finder@example.org",
    added_at: T0 + 3,
  });
});

test("resolving records one field change and drops the report from the list", async () => {
  await resolveFound(store, "01000000000000000000000002");
  expect(store.pending.map((e) => [e.entity_type, e.type, e.payload])).toEqual([
    ["found_report", "field_changed", { field: "resolved", value: true, old: null }],
  ]);
  expect(foundFor(store.state, "tent").map((r) => r.note)).toEqual(["by the gate"]);

  // Twice is once.
  await resolveFound(store, "01000000000000000000000002");
  expect(store.pending).toHaveLength(1);
});
