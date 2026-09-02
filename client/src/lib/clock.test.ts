import { expect, test } from "vitest";
import { measureOffset } from "./clock";

test("offset is server time minus the middle of the round trip", () => {
  expect(measureOffset(1_000, 900, 1_100)).toBe(0);
  expect(measureOffset(5_000, 900, 1_100)).toBe(4_000);
  expect(measureOffset(500, 900, 1_100)).toBe(-500);
});

test("an odd round trip rounds rather than leaving a fraction", () => {
  expect(Number.isInteger(measureOffset(1_000, 900, 1_101))).toBe(true);
});
