import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { registerSW } from "virtual:pwa-register";
import { update, watchForUpdates } from "./update";

type Options = NonNullable<Parameters<typeof registerSW>[0]>;

function fakeRegister() {
  const calls: boolean[] = [];
  const captured: { opts?: Options } = {};
  const register = ((opts: Options) => {
    captured.opts = opts;
    return async (reload?: boolean) => {
      calls.push(reload === true);
    };
  }) as typeof registerSW;
  return { register, calls, captured };
}

function fakeReg(fail = false) {
  const reg = {
    count: 0,
    update: async () => {
      reg.count++;
      if (fail) throw new Error("offline");
    },
  };
  return reg;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

let stop = () => {};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stop();
  stop = () => {};
  update.reset();
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

test("a waiting build marks an update ready, and applying installs it", () => {
  const { register, calls, captured } = fakeRegister();
  stop = watchForUpdates(register);
  expect(captured.opts?.immediate).toBe(true);
  captured.opts!.onNeedRefresh!();
  expect(update.ready).toBe(true);
  update.apply();
  expect(calls).toEqual([true]);
});

test("the tab that asked reloads when the new worker takes over", () => {
  const { register, captured } = fakeRegister();
  let reloads = 0;
  stop = watchForUpdates(register, { reload: () => reloads++ });
  captured.opts!.onNeedRefresh!();
  update.apply();
  captured.opts!.onNeedReload!();
  expect(reloads).toBe(1);
});

test("a tab that did not ask keeps the banner, and its Reload reloads", () => {
  const { register, captured } = fakeRegister();
  let reloads = 0;
  stop = watchForUpdates(register, { reload: () => reloads++ });
  captured.opts!.onNeedRefresh!();
  captured.opts!.onNeedReload!();
  expect(reloads).toBe(0);
  expect(update.ready).toBe(true);
  update.apply();
  expect(reloads).toBe(1);
});

test("it looks for a build on the interval, not while hidden", () => {
  const { register, captured } = fakeRegister();
  stop = watchForUpdates(register, { everyMs: 1000 });
  const reg = fakeReg();
  captured.opts!.onRegisteredSW!("/sw.js", reg as unknown as ServiceWorkerRegistration);
  vi.advanceTimersByTime(2500);
  expect(reg.count).toBe(2);
  setVisibility("hidden");
  vi.advanceTimersByTime(3000);
  expect(reg.count).toBe(2);
});

test("it looks when the tab returns, at most every 5 minutes", () => {
  const { register, captured } = fakeRegister();
  stop = watchForUpdates(register, { everyMs: 60 * 60 * 1000 });
  const reg = fakeReg();
  captured.opts!.onRegisteredSW!("/sw.js", reg as unknown as ServiceWorkerRegistration);
  setVisibility("visible");
  expect(reg.count).toBe(1);
  setVisibility("visible");
  expect(reg.count).toBe(1);
  vi.advanceTimersByTime(5 * 60 * 1000 + 1);
  setVisibility("visible");
  expect(reg.count).toBe(2);
});

test("a check that fails offline is ignored", async () => {
  const { register, captured } = fakeRegister();
  stop = watchForUpdates(register, { everyMs: 1000 });
  const reg = fakeReg(true);
  captured.opts!.onRegisteredSW!("/sw.js", reg as unknown as ServiceWorkerRegistration);
  await vi.advanceTimersByTimeAsync(1000);
  expect(reg.count).toBe(1);
});

test("no registration, nothing to check", () => {
  const { register, captured } = fakeRegister();
  const remove = vi.spyOn(document, "addEventListener");
  stop = watchForUpdates(register, { everyMs: 1000 });
  captured.opts!.onRegisteredSW!("/sw.js", undefined);
  expect(remove).not.toHaveBeenCalledWith("visibilitychange", expect.anything());
  expect(vi.getTimerCount()).toBe(0);
  remove.mockRestore();
});
