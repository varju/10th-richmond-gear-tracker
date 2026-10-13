import { afterEach, expect, test, vi } from "vitest";
import { NATIVE_CLASS, NATIVE_STOPPED, startScanner } from "./scanner";

vi.mock("zxing-wasm/reader", () => ({ prepareZXingModule: () => {}, readBarcodes: () => new Promise(() => {}) }));

/**
 * The app's ScannerPlugin as the page sees it: calls are recorded, and `start` settles as the test says. As the
 * plugin does, a start that lands is followed by `ready` once the camera runs.
 */
function fakeBridge(start: () => Promise<unknown> = async () => undefined, torch = true) {
  const calls: { method: string; args: object }[] = [];
  const listeners = new Map<string, (data: unknown) => void>();
  const removed: string[] = [];
  const send = (event: string, data: unknown = {}) => listeners.get(event)?.(data);
  const bridge = {
    isPluginAvailable: (name: string) => name === "ScannerPlugin",
    nativePromise: vi.fn(async (plugin: string, method: string, args: object) => {
      expect(plugin).toBe("ScannerPlugin");
      calls.push({ method, args });
      if (method !== "start") return undefined;
      const result = await start();
      setTimeout(() => send("ready", { torch }), 0);
      return result;
    }),
    addListener: (_plugin: string, event: string, callback: (data: unknown) => void) => {
      listeners.set(event, callback);
      return { remove: async () => void removed.push(event) };
    },
  };
  const methods = () => calls.map((c) => c.method);
  const layouts = () => calls.filter((c) => c.method === "layout").map((c) => c.args);
  return { bridge, calls, methods, layouts, send, removed };
}

function viewfinder() {
  const view = document.createElement("div");
  const video = document.createElement("video");
  view.append(video);
  document.body.append(view);
  return video;
}

const at = (el: Element, x: number, y: number, w: number, h: number) =>
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(x, y, w, h));

const frames = () => new Promise((r) => setTimeout(r, 50));

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.classList.remove(NATIVE_CLASS);
  // @ts-expect-error test-only cleanup of browser APIs stubbed per test
  delete navigator.mediaDevices;
});

test("in the app, the native scanner is used, and each code it sends reaches onCode", async () => {
  const fake = fakeBridge();
  const getUserMedia = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  const codes: string[] = [];
  const onReady = vi.fn();
  const scanner = startScanner(viewfinder(), (t) => codes.push(t), { onReady }, fake.bridge, true);
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledWith({ torch: true }));
  await frames();
  expect(document.documentElement.classList.contains(NATIVE_CLASS)).toBe(true);
  // Once each: no second ready or layout for the same start.
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(fake.methods()).toEqual(["start", "layout"]);
  // The plugin drops repeats in this window, so a code in view is not sent every frame.
  expect(fake.calls[0]?.args).toEqual({ room: 1.5, repeatMs: 1500 });

  fake.send("code", { text: "A" });
  fake.send("code", { text: "B" });
  expect(codes).toEqual(["A", "B"]);
  expect(getUserMedia).not.toHaveBeenCalled();
  scanner.stop();
});

test("pause, resume, torch and stop reach the plugin; stop clears the page's see-through mode", async () => {
  const fake = fakeBridge();
  const codes: string[] = [];
  const onReady = vi.fn();
  const scanner = startScanner(viewfinder(), (t) => codes.push(t), { onReady }, fake.bridge, true);
  await vi.waitFor(() => expect(onReady).toHaveBeenCalled());

  scanner.pause();
  scanner.resume();
  scanner.torch?.(true);
  scanner.stop();
  expect(fake.methods()).toEqual(["start", "layout", "pause", "resume", "torch", "stop"]);
  expect(fake.calls[4]?.args).toEqual({ on: true });
  expect(document.documentElement.classList.contains(NATIVE_CLASS)).toBe(false);
  expect(fake.removed.sort()).toEqual(["code", "error", "ready"]);
  fake.send("code", { text: "B" });
  expect(codes).toEqual([]);
});

test("a pause before the camera has started is applied once it has", async () => {
  let land: (v: unknown) => void = () => {};
  const fake = fakeBridge(() => new Promise((r) => (land = r)));
  const onReady = vi.fn();
  const scanner = startScanner(viewfinder(), () => {}, { onReady }, fake.bridge, true);
  scanner.pause(); // a typed code opened the card during the permission prompt
  land(undefined);
  await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
  expect(fake.methods()).toEqual(["start", "layout", "pause"]);
  scanner.resume();
  expect(fake.methods()).toEqual(["start", "layout", "pause", "resume"]);
  scanner.stop();
});

test("a pause before the fallback's camera opens is applied once it has", async () => {
  const fake = fakeBridge(async () => Promise.reject(Object.assign(new Error("no session"), { code: "failed" })));
  const getUserMedia = vi.fn(async () => Object.assign(new MediaStream(), { getTracks: () => [] }));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  const video = viewfinder();
  const paused = vi.spyOn(video, "pause");
  const onReady = vi.fn();
  const scanner = startScanner(video, () => {}, { onReady }, fake.bridge, true);
  scanner.pause();
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledWith({ torch: false }));
  expect(paused).toHaveBeenCalled();
  scanner.stop();
});

test("the viewfinder and target are sent where they sit on screen, less a keyboard pan", async () => {
  const fake = fakeBridge();
  const video = viewfinder();
  const target = document.createElement("div");
  video.parentElement!.append(target);
  at(video.parentElement!, 0, 100, 390, 500);
  at(target, 85, 240, 220, 220);
  const visualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
  Object.defineProperty(window, "visualViewport", { value: { offsetLeft: 0, offsetTop: 0 }, configurable: true });
  const onReady = vi.fn();
  const scanner = startScanner(video, () => {}, { target: () => target, onReady }, fake.bridge, true);
  await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
  expect(fake.layouts()).toEqual([
    { view: { x: 0, y: 100, w: 390, h: 500 }, target: { x: 85, y: 240, w: 220, h: 220 } },
  ]);

  // The keyboard opens and iOS pans the page up 120 px: the viewfinder is that much higher on screen.
  Object.defineProperty(window, "visualViewport", { value: { offsetLeft: 0, offsetTop: 120 }, configurable: true });
  await vi.waitFor(() => expect(fake.layouts()).toHaveLength(2));
  expect(fake.layouts()[1]).toEqual({
    view: { x: 0, y: -20, w: 390, h: 500 },
    target: { x: 85, y: 120, w: 220, h: 220 },
  });
  if (visualViewport) Object.defineProperty(window, "visualViewport", visualViewport);
  // @ts-expect-error test-only cleanup of the stubbed viewport
  else delete window.visualViewport;
  scanner.stop();
});

test("a viewfinder that moves without resizing, or a target that appears late, is sent again", async () => {
  const fake = fakeBridge();
  const video = viewfinder();
  const view = video.parentElement!;
  at(view, 0, 100, 390, 500);
  let target: HTMLElement | null = null;
  const onReady = vi.fn();
  const scanner = startScanner(video, () => {}, { target: () => target, onReady }, fake.bridge, true);
  await vi.waitFor(() => expect(fake.layouts()).toHaveLength(1));
  expect(fake.layouts()[0]).toMatchObject({ target: null });

  at(view, 0, 156, 390, 500); // a row above it grew
  await vi.waitFor(() => expect(fake.layouts()).toHaveLength(2));
  expect(fake.layouts()[1]).toMatchObject({ view: { y: 156 } });

  target = document.createElement("div");
  at(target, 85, 296, 220, 220);
  await vi.waitFor(() => expect(fake.layouts()).toHaveLength(3));
  expect(fake.layouts()[2]).toMatchObject({ target: { x: 85, y: 296 } });

  await frames();
  expect(fake.layouts()).toHaveLength(3); // nothing moved: nothing sent
  scanner.stop();
  at(view, 0, 0, 390, 500);
  await frames();
  expect(fake.layouts()).toHaveLength(3);
});

test("a native start that fails for another reason falls back to the web scanner", async () => {
  const fake = fakeBridge(async () => Promise.reject(Object.assign(new Error("no session"), { code: "failed" })));
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  const onError = vi.fn();
  const scanner = startScanner(viewfinder(), () => {}, { onError }, fake.bridge, true);
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  expect(onError).not.toHaveBeenCalled();
  expect(document.documentElement.classList.contains(NATIVE_CLASS)).toBe(false);
  scanner.stop();
});

test("a refused or missing camera is explained for the app, and the web camera is not tried", async () => {
  for (const [code, message] of [
    ["denied", /refused\. Allow it for this app in Settings/],
    ["nocamera", /No camera/],
  ] as const) {
    const fake = fakeBridge(async () => Promise.reject(Object.assign(new Error("no"), { code })));
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    const onError = vi.fn();
    const scanner = startScanner(viewfinder(), () => {}, { onError }, fake.bridge, true);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(message)));
    expect(getUserMedia).not.toHaveBeenCalled();
    scanner.stop();
  }
});

test("the camera stopping says coming back to the app tries again, and its return clears that", async () => {
  const fake = fakeBridge(undefined, false);
  const onError = vi.fn();
  const onReady = vi.fn();
  const scanner = startScanner(viewfinder(), () => {}, { onError, onReady }, fake.bridge, true);
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  fake.send("error");
  expect(onError).toHaveBeenCalledWith(NATIVE_STOPPED);
  expect(NATIVE_STOPPED).toMatch(/come back/);
  fake.send("ready", { torch: false });
  expect(onReady).toHaveBeenCalledTimes(2);
  scanner.stop();
});

test("stop before the native start lands leaves nothing on", async () => {
  let land: (v: unknown) => void = () => {};
  const fake = fakeBridge(() => new Promise((r) => (land = r)));
  const onReady = vi.fn();
  const scanner = startScanner(viewfinder(), () => {}, { onReady }, fake.bridge, true);
  scanner.stop();
  land(undefined);
  await frames();
  expect(onReady).not.toHaveBeenCalled();
  expect(document.documentElement.classList.contains(NATIVE_CLASS)).toBe(false);
  expect(fake.methods()).toEqual(["start", "stop"]);
});

test("outside the app, or in an app build without the plugin, the web scanner is used", () => {
  for (const [bridge, native] of [
    [fakeBridge().bridge, false],
    [{ ...fakeBridge().bridge, isPluginAvailable: () => false }, true],
  ] as const) {
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    const scanner = startScanner(viewfinder(), () => {}, {}, bridge, native);
    expect(bridge.nativePromise).not.toHaveBeenCalled();
    scanner.stop();
  }
});
