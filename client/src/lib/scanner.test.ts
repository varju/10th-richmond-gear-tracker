import { expect, test } from "vitest";
import { cameraError, Debounce } from "./scanner";

test("the same code within the window is reported once", () => {
  const d = new Debounce(1500);
  expect(d.accept("A", 0)).toBe(true);
  expect(d.accept("A", 100)).toBe(false);
  expect(d.accept("A", 1499)).toBe(false);
  expect(d.accept("A", 1500)).toBe(true);
});

test("a different code is reported straight away, and resets the window", () => {
  const d = new Debounce(1500);
  expect(d.accept("A", 0)).toBe(true);
  expect(d.accept("B", 10)).toBe(true);
  expect(d.accept("A", 20)).toBe(true);
  expect(d.accept("A", 30)).toBe(false);
});

test("camera errors are explained", () => {
  expect(cameraError(new DOMException("x", "NotAllowedError"))).toMatch(/refused/);
  expect(cameraError(new DOMException("x", "NotFoundError"))).toMatch(/No camera/);
  expect(cameraError(new Error("?"))).toMatch(/could not start/);
});
