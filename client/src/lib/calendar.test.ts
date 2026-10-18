import { expect, test } from "vitest";
import type { CalendarEvent } from "./api";
import { eventDates, eventsOn, matchingEvents } from "./calendar";
import { corrections, usedEventNames } from "./movement";
import type { ReplayEvent } from "./replay";

const ev = (uid: string, summary: string, starts: string, ends = starts): CalendarEvent => ({
  uid,
  summary,
  starts,
  ends,
  all_day: true,
});

test("feeds listing the same event on the same dates are one row; other dates stay separate (FR-RES-26)", () => {
  const feeds = [
    ev("a", "Apple Day", "2026-10-18"),
    ev("b", " apple  day ", "2026-10-18"),
    ev("c", "Apple Day", "2026-10-18"),
    ev("d", "Apple Day", "2027-10-17"),
    ev("e", "Cub camp", "2026-10-17", "2026-10-19"),
  ];
  expect(eventsOn(feeds, "2026-10-18").map((e) => e.uid)).toEqual(["e", "a"]);
  expect(matchingEvents(feeds, "apple").map((e) => [e.summary, e.starts])).toEqual([
    ["Apple Day", "2026-10-18"],
    ["Apple Day", "2027-10-17"],
  ]);
});

test("the limit counts rows after merging (FR-RES-26)", () => {
  const feeds = [1, 2, 3].flatMap((n) => [
    ev(`a${n}`, `Camp ${n}`, "2026-10-18"),
    ev(`b${n}`, `Camp ${n}`, "2026-10-18"),
  ]);
  expect(matchingEvents(feeds, "camp", [], 3).map((e) => e.summary)).toEqual(["Camp 1", "Camp 2", "Camp 3"]);
  expect(eventsOn(feeds, "2026-10-18", 2).map((e) => e.summary)).toEqual(["Camp 1", "Camp 2"]);
});

test("typing also finds names used before, after the calendar's, and none a calendar row already names (FR-RES-27)", () => {
  const feeds = [ev("a", "Fall camp", "2026-11-01")];
  const found = matchingEvents(feeds, "camp", ["fall camp", "Spring camp", "Apple Day"]);
  expect(found).toEqual([feeds[0], { summary: "Spring camp" }]);
  expect(eventDates(found[1]!)).toBe("Used before");
  expect(matchingEvents(feeds, "  ", ["Spring camp"])).toEqual([]);
});

test("used names come from reservations, current movements and the log, newest first, once each (FR-RES-27)", () => {
  const state = {
    reservation: {
      r1: { event: "Fall camp", added_at: 10 },
      r2: { event: "  ", added_at: 50 },
      r3: { event: "Cancelled camp", added_at: 55, cancelled: true },
    },
    item: {
      i1: { movement: { id: "m1", event: "Cub camp", at: 30 } },
      i2: { movement: { id: "m2", event: null, at: 40 } },
    },
  };
  const rec = (id: string, type: string, payload: Record<string, unknown>, effective_at: number): ReplayEvent => ({
    id,
    entity_type: "item",
    entity_id: "i3",
    type,
    actor_id: "alice",
    device_id: "d1",
    device_seq: effective_at,
    effective_at,
    payload,
  });
  const log = [
    rec("o1", "checked_out", { event: "fall  camp" }, 20),
    // A typo, corrected twice: only the last reading counts, ranked by its time.
    rec("o2", "checked_out", { event: "Aple Day" }, 25),
    rec("c2", "event_corrected", { movement_id: "o2", event: "Apple Day" }, 65),
    rec("c1", "event_corrected", { movement_id: "o2", event: "Apple Dya" }, 60),
    rec("f1", "field_changed", { event: "Not an event" }, 70),
  ];
  expect(usedEventNames(state, log, corrections(log))).toEqual(["Apple Day", "Cub camp", "fall camp"]);
});
