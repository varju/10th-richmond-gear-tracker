import { afterEach, expect, test, vi } from "vitest";
import { cameraError, click, Debounce, startScanner, unlockSound, vibrate } from "./scanner";

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

afterEach(() => {
  // @ts-expect-error test-only cleanup of browser APIs stubbed per test
  delete navigator.mediaDevices;
  // @ts-expect-error test-only cleanup of browser APIs stubbed per test
  delete navigator.vibrate;
});

test("vibrate buzzes through the Vibration API where it exists", () => {
  const buzz = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: buzz, configurable: true });
  vibrate();
  expect(buzz).toHaveBeenCalledWith(30);
  expect(document.querySelector("input[switch]")).toBeNull(); // no need for the switch here
});

test("without the Vibration API (iOS Safari) vibrate toggles one hidden switch, made once", () => {
  vibrate(); // no navigator.vibrate by default in this test environment
  expect(document.querySelectorAll("input[switch]")).toHaveLength(1);
  const hidden = document.querySelector<HTMLInputElement>("input[switch]")!;
  expect(hidden.checked).toBe(true);
  expect(hidden.style.display).toBe("none");
  vibrate();
  expect(document.querySelectorAll("input[switch]")).toHaveLength(1);
  expect(hidden.checked).toBe(false);
});

/** The parts of AudioContext a click touches. A stand-in: the test environment has no sound card. */
class FakeAudioContext {
  static made = 0;
  static last: FakeAudioContext | null = null;
  state = "suspended";
  currentTime = 0;
  destination = {};
  started: number[] = [];
  constructor() {
    FakeAudioContext.made += 1;
    FakeAudioContext.last = this;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  createGain() {
    const node = { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => node };
    return node;
  }
  createOscillator() {
    const self = this;
    const node = {
      frequency: { value: 0 },
      connect: () => node,
      start(at: number) {
        self.started.push(at);
      },
      stop() {},
    };
    return node;
  }
}

test("a click is quiet until a tap has unlocked sound, and quiet where there is no Web Audio", () => {
  expect(() => click()).not.toThrow(); // no AudioContext in this test environment
  expect(() => unlockSound()).not.toThrow();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  try {
    unlockSound();
    unlockSound(); // a second tap reuses the one context
    expect(FakeAudioContext.made).toBe(1);
    click();
    expect(FakeAudioContext.last?.started).toEqual([0]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("pause freezes the video and resume un-freezes it, without reopening the camera", async () => {
  // A MediaStream this test environment can both assign to video.srcObject and stop.
  const stream = Object.assign(new MediaStream(), { getTracks: () => [] });
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  const video = document.createElement("video");
  const pauseSpy = vi.spyOn(video, "pause");
  const playSpy = vi.spyOn(video, "play");

  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));

  scanner.pause();
  expect(pauseSpy).toHaveBeenCalledTimes(1);

  scanner.resume();
  expect(playSpy).toHaveBeenCalledTimes(2);

  scanner.stop();
  expect(getUserMedia).toHaveBeenCalledTimes(1); // the camera is opened once, never restarted for a pause
});
