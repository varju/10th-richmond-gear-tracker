import { expect, test } from "vitest";
import { isUlid, newUlid } from "./ulid";

test("a new ulid has the shape the server checks", () => {
  expect(isUlid(newUlid())).toBe(true);
  expect(isUlid("not-a-ulid")).toBe(false);
  expect(isUlid(42)).toBe(false);
});

test("the time prefix sorts by time", () => {
  const earlier = newUlid(1_000);
  const later = newUlid(2_000);
  expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true);
});

test("the same millisecond gives different ids", () => {
  const seen = new Set(Array.from({ length: 100 }, () => newUlid(1_000)));
  expect(seen.size).toBe(100);
});
