// The camera, stood in for at its edge: the iPhone app's scanner plugin, or the browser's camera and decoder.
import { act, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import { NATIVE_CLASS } from "../lib/scanner";

export interface FakeCamera {
  /** A read, as the plugin reports one. Dropped while paused, as the plugin drops it. */
  scan(text: string): Promise<void>;
  /** The plugin methods called, in order. */
  calls: string[];
  /** Each torch call: on or off. */
  torch: boolean[];
}

export function fakeCamera(): FakeCamera {
  const calls: string[] = [];
  const torch: boolean[] = [];
  const listeners = new Map<string, (data: unknown) => void>();
  let paused = false;
  vi.stubGlobal("Capacitor", {
    isPluginAvailable: () => true,
    nativePromise: async (_plugin: string, method: string, args: { on?: boolean }) => {
      calls.push(method);
      if (method === "torch") torch.push(args.on === true);
      if (method === "pause") paused = true;
      if (method === "resume" || method === "start") paused = false;
      // As the plugin does: the camera runs once start lands, and says so.
      if (method === "start") setTimeout(() => listeners.get("ready")?.({ torch: true }), 0);
      return undefined;
    },
    addListener: (_plugin: string, event: string, callback: (data: unknown) => void) => {
      listeners.set(event, callback);
      return { remove: async () => undefined };
    },
  });
  return {
    calls,
    torch,
    async scan(text: string) {
      await waitFor(() => expect(document.documentElement).toHaveClass(NATIVE_CLASS));
      if (paused) return;
      await act(async () => listeners.get("code")?.({ text }));
    },
  };
}

export function stopFakeCamera(): void {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove(NATIVE_CLASS);
}

// Undoes what the web camera stubbed: each restores what was there before.
const undo: (() => void)[] = [];

/** A getter on `proto` or its chain answers `value`; without one, `value` is defined there until undone. */
function stubGetter(proto: object, key: string, value: unknown): void {
  if (key in proto) {
    const spy = vi.spyOn(proto as Record<string, unknown>, key, "get").mockReturnValue(value);
    undo.push(() => spy.mockRestore());
  } else {
    Object.defineProperty(proto, key, { get: () => value, configurable: true });
    undo.push(() => delete (proto as Record<string, unknown>)[key]);
  }
}

/** Every video has a frame to draw, and every canvas draws it. The test DOM has neither. */
export function stubFrames(): void {
  stubGetter(HTMLMediaElement.prototype, "readyState", 4);
  stubGetter(HTMLVideoElement.prototype, "videoWidth", 1280);
  stubGetter(HTMLVideoElement.prototype, "videoHeight", 720);
  const ctx = { drawImage() {}, getImageData: () => ({}) } as unknown as CanvasRenderingContext2D;
  const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  undo.push(() => spy.mockRestore());
}

/**
 * The browser's camera, with frames for the page's own scanner to decode. `decoded` is what the test's
 * zxing-wasm mock reads from, one text per frame; the returned function holds a sticker up until it is read.
 */
export function webCamera(decoded: string[]): (text: string) => Promise<void> {
  const stream = Object.assign(new MediaStream(), { getTracks: () => [] });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => stream }, configurable: true });
  undo.push(() => delete (navigator as { mediaDevices?: unknown }).mediaDevices);
  stubFrames();
  return async (text) => {
    decoded.push(text);
    await waitFor(() => expect(decoded).toHaveLength(0));
  };
}

export function stopWebCamera(): void {
  undo
    .splice(0)
    .reverse()
    .forEach((f) => f());
}
