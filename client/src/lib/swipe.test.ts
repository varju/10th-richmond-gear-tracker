import { afterEach, expect, test, vi } from "vitest";
import { startSwipe } from "./swipe";
import { unsaved } from "./unsaved";

let stop = () => {};
afterEach(() => {
  stop();
  unsaved.unregister("form");
});

function start(impl: () => Promise<unknown> = async () => undefined, native = true) {
  const nativePromise = vi.fn(impl);
  stop = startSwipe({ nativePromise } as unknown as NonNullable<typeof window.Capacitor>, native);
  return nativePromise;
}

test("a draft turns the swipe off, and finishing it turns it back on", () => {
  const native = start();
  expect(native).toHaveBeenLastCalledWith("SwipePlugin", "set", { on: true });
  unsaved.register("form", {});
  expect(native).toHaveBeenLastCalledWith("SwipePlugin", "set", { on: false });
  unsaved.unregister("form");
  expect(native).toHaveBeenLastCalledWith("SwipePlugin", "set", { on: true });
  expect(native).toHaveBeenCalledTimes(3);
});

test("the dialog opening and closing sends nothing more", () => {
  const native = start();
  unsaved.register("form", {});
  unsaved.ask(() => {});
  unsaved.cancel();
  expect(native).toHaveBeenCalledTimes(2);
});

test("on the web, nothing is sent", () => {
  const native = start(async () => undefined, false);
  unsaved.register("form", {});
  expect(native).not.toHaveBeenCalled();
});

test("a build without the plugin is not an error", async () => {
  const native = start(() => Promise.reject(new Error("no plugin")));
  unsaved.register("form", {});
  await Promise.resolve();
  expect(native).toHaveBeenCalledTimes(2);
});

test("a draft already open at start turns the swipe off at once", () => {
  unsaved.register("form", {});
  const native = start();
  expect(native).toHaveBeenCalledExactlyOnceWith("SwipePlugin", "set", { on: false });
});
