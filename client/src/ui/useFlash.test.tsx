import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CONFIRM_MS, MOVED_MS, useFlash } from "./MoveActions";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

test("a move's confirmation stays 4 seconds; the move buttons hold 1.5 (FR-OUT-53, FR-OUT-52)", () => {
  expect(MOVED_MS).toBe(4000);
  expect(CONFIRM_MS).toBe(1500);
});

test("a message stays until its time is up", () => {
  const { result } = renderHook(() => useFlash(1000));
  act(() => result.current[1]("Done"));
  tick(999);
  expect(result.current[0]).toBe("Done");
  tick(1);
  expect(result.current[0]).toBeNull();
});

test("a newer identical message gets its full time", () => {
  const { result } = renderHook(() => useFlash(1000));
  act(() => result.current[1]("Done"));
  tick(600);
  act(() => result.current[1]("Done"));
  tick(600);
  expect(result.current[0]).toBe("Done");
  tick(400);
  expect(result.current[0]).toBeNull();
});

test("clear removes the message", () => {
  const { result } = renderHook(() => useFlash(1000));
  act(() => result.current[1]("Done"));
  act(() => result.current[2]());
  expect(result.current[0]).toBeNull();
});
