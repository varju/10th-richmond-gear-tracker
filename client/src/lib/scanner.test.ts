import { afterEach, expect, test, vi } from "vitest";
import {
  cameraError,
  click,
  cropFor,
  Debounce,
  AWAY_MS,
  ENDED_WAIT_MS,
  STABLE_MS,
  UNMUTE_WAIT_MS,
  startScanner,
  unlockSound,
  vibrate,
} from "./scanner";
import { setVisibility } from "./visibilityTestKit";

// The decoder, held open so a test chooses when a frame's read lands and what it says, or that it fails.
const decoder = vi.hoisted(() => ({ pending: [] as ((read: string | Error) => void)[] }));
vi.mock("zxing-wasm/reader", () => ({
  prepareZXingModule: () => {},
  readBarcodes: () =>
    new Promise((resolve, reject) =>
      decoder.pending.push((read) => (read instanceof Error ? reject(read) : resolve([{ text: read }]))),
    ),
}));

test("the same code within the window is reported once", () => {
  const d = new Debounce(1500);
  expect(d.accept("A", 0)).toBe(true);
  expect(d.accept("A", 100)).toBe(false);
  expect(d.accept("A", 1499)).toBe(false);
  expect(d.accept("A", 1500)).toBe(true);
});

test("the decoded region is the target box with room around it, in frame pixels, not the whole frame", () => {
  // A landscape 1280×720 frame covering a portrait 390×520 element: the sides of the frame are cut off.
  const frame = { w: 1280, h: 720 };
  const shown = { w: 390, h: 520 };
  const box = { x: 85, y: 150, w: 220, h: 220 }; // centred, as .target is
  const crop = cropFor(frame, shown, box);
  // cover scale is 520/720 = 0.722; the box is 220/0.722 = 305 frame px, times 1.5 room = 457.
  expect(crop.w).toBe(457);
  expect(crop.h).toBe(457);
  // Centred on the frame, since the box is centred on the element.
  expect(Math.abs(crop.x + crop.w / 2 - 640)).toBeLessThanOrEqual(1);
  expect(Math.abs(crop.y + crop.h / 2 - 360)).toBeLessThanOrEqual(1);
  // Well inside the frame: the cut-off sides (about 360 px each) are never decoded.
  expect(crop.x).toBeGreaterThan(360);
});

test("the crop is clamped to the frame, and is the whole frame with no target or before layout", () => {
  const frame = { w: 640, h: 480 };
  expect(cropFor(frame, { w: 320, h: 240 }, null)).toEqual({ x: 0, y: 0, w: 640, h: 480 });
  expect(cropFor(frame, { w: 0, h: 0 }, { x: 0, y: 0, w: 100, h: 100 })).toEqual({ x: 0, y: 0, w: 640, h: 480 });
  // A box at the corner: the room around it cannot go past the frame's edge, so it shifts inward.
  const corner = cropFor(frame, { w: 320, h: 240 }, { x: 0, y: 0, w: 100, h: 100 });
  expect(corner).toEqual({ x: 0, y: 0, w: 300, h: 300 });
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

test("vibrate buzzes where the API exists, and is quiet where it does not (iOS Safari)", () => {
  expect(() => vibrate()).not.toThrow(); // no navigator.vibrate by default in this test environment
  const buzz = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: buzz, configurable: true });
  vibrate();
  expect(buzz).toHaveBeenCalledWith(30);
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
  const { getUserMedia } = fakeCamera();
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

/** A camera whose streams can be counted: each getUserMedia call hands out a new stream with one track. */
function fakeCamera() {
  const tracks: {
    stop: ReturnType<typeof vi.fn>;
    ended: () => void;
    expire: () => void;
    mute: () => void;
    unmute: () => void;
  }[] = [];
  const open = () => tracks.filter((t) => !t.stop.mock.calls.length).length;
  const getUserMedia = vi.fn(async () => {
    const target = new EventTarget();
    const track = Object.assign(target, { stop: vi.fn(), readyState: "live", muted: false });
    const expire = () => {
      track.readyState = "ended";
    };
    tracks.push({
      stop: track.stop,
      expire,
      ended: () => (expire(), target.dispatchEvent(new Event("ended"))),
      mute: () => {
        track.muted = true;
        target.dispatchEvent(new Event("mute"));
      },
      unmute: () => {
        track.muted = false;
        target.dispatchEvent(new Event("unmute"));
      },
    });
    return Object.assign(new MediaStream(), { getTracks: () => [track] });
  });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  return { getUserMedia, tracks, open };
}

/** A long trip away: iOS ends the tracks while the app is in the background, and says nothing until it is back. */
function awayLong(camera: ReturnType<typeof fakeCamera>) {
  setVisibility("hidden");
  camera.tracks.forEach((t) => t.expire());
  setVisibility("visible");
}

test("a short trip away keeps the stream and picks it up again", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const playSpy = vi.spyOn(video, "play");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  video.style.opacity = ""; // as if the first frame had shown

  setVisibility("hidden");
  setVisibility("visible");
  expect(camera.getUserMedia).toHaveBeenCalledTimes(1);
  expect(camera.open()).toBe(1);
  expect(playSpy).toHaveBeenCalledTimes(2);
  expect(video.style.opacity).toBe(""); // not hidden again: nothing to settle

  scanner.stop();
  expect(camera.open()).toBe(0);
  setVisibility("hidden");
  setVisibility("visible");
  await new Promise((r) => setTimeout(r, 10));
  expect(playSpy).toHaveBeenCalledTimes(2); // no listener left after stop
});

test("a long trip away, with the track ended, opens the camera again", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  awayLong(camera);
  await vi.waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  expect(camera.open()).toBe(1);
  scanner.stop();
  expect(camera.open()).toBe(0);
});

test("a hidden page does not decode, though its track is still live", async () => {
  fakeCamera();
  const video = document.createElement("video");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  const rafSpy = vi.spyOn(window, "requestAnimationFrame");
  const cancelSpy = vi.spyOn(window, "cancelAnimationFrame");
  setVisibility("hidden");
  expect(cancelSpy).toHaveBeenCalled();
  await new Promise((r) => setTimeout(r, 50));
  expect(rafSpy).not.toHaveBeenCalled();
  setVisibility("visible");
  expect(rafSpy).toHaveBeenCalled();
  scanner.stop();
  rafSpy.mockRestore();
  cancelSpy.mockRestore();
});

test("a fast hide and show leaves one stream open, and stop during a reopen leaves none", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const scanner = startScanner(video, () => {});
  setVisibility("hidden"); // before the first open has resolved
  setVisibility("visible");
  setVisibility("hidden");
  setVisibility("visible");
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  await new Promise((r) => setTimeout(r, 10));
  expect(camera.open()).toBe(1);

  awayLong(camera); // reopen in flight
  scanner.stop();
  await new Promise((r) => setTimeout(r, 10));
  expect(camera.open()).toBe(0);
  expect(video.srcObject).toBeNull();
});

test("stop while hidden leaves nothing open, and coming back does not reopen", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  setVisibility("hidden");
  scanner.stop();
  setVisibility("visible");
  await new Promise((r) => setTimeout(r, 10));
  expect(camera.getUserMedia).toHaveBeenCalledTimes(1);
  expect(camera.open()).toBe(0);
});

test("a track that ends on its own is reopened", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  camera.tracks[0]?.ended();
  await vi.waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  expect(camera.open()).toBe(1);
  scanner.stop();
});

test("a camera error on coming back is reported", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const onError = vi.fn();
  const scanner = startScanner(video, () => {}, { onError });
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  camera.getUserMedia.mockRejectedValueOnce(new DOMException("x", "NotReadableError"));
  awayLong(camera);
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/in use/)));
  scanner.stop();
});

test("a short trip away with the frame frozen comes back frozen", async () => {
  fakeCamera();
  const video = document.createElement("video");
  const playSpy = vi.spyOn(video, "play");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  scanner.pause();
  const rafSpy = vi.spyOn(window, "requestAnimationFrame");
  setVisibility("hidden");
  setVisibility("visible");
  expect(playSpy).toHaveBeenCalledTimes(1);
  expect(rafSpy).not.toHaveBeenCalled();
  scanner.resume();
  expect(playSpy).toHaveBeenCalledTimes(2);
  expect(rafSpy).toHaveBeenCalled();
  scanner.stop();
  rafSpy.mockRestore();
});

test("a reopen with the frame frozen plays behind the card but does not decode until resume", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const playSpy = vi.spyOn(video, "play");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  scanner.pause();
  awayLong(camera);
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(2)); // a live picture behind the card, not black
  const rafSpy = vi.spyOn(window, "requestAnimationFrame");
  await new Promise((r) => setTimeout(r, 10));
  expect(rafSpy).not.toHaveBeenCalled(); // no decoding while paused
  scanner.resume();
  expect(rafSpy).toHaveBeenCalled();
  scanner.stop();
  rafSpy.mockRestore();
});

test("the video stays see-through until frames at the settled size are shown, and again after a reopen", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const frames: VideoFrameRequestCallback[] = [];
  video.requestVideoFrameCallback = (cb) => frames.push(cb);
  video.cancelVideoFrameCallback = () => frames.splice(0);
  Object.defineProperty(video, "videoWidth", { value: 1280, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 720, configurable: true });
  const present = (width: number, height: number) =>
    frames.shift()?.(0, { width, height } as VideoFrameCallbackMetadata);

  const scanner = startScanner(video, () => {});
  expect(video.style.opacity).toBe("0");
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  present(720, 1280); // a first frame the wrong way round
  expect(video.style.opacity).toBe("0");
  present(1280, 720); // first open: the settled size is enough
  expect(video.style.opacity).toBe("");

  awayLong(camera);
  expect(video.style.opacity).toBe("0");
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  present(1280, 720);
  present(1280, 720);
  expect(video.style.opacity).toBe("0"); // after a reopen WebKit may not have sized the layer yet
  present(1280, 720);
  expect(video.style.opacity).toBe("");
  scanner.stop();
});

test("without requestVideoFrameCallback the video shows once data has loaded", async () => {
  fakeCamera();
  const video = document.createElement("video");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  expect(video.style.opacity).toBe("0");
  video.dispatchEvent(new Event("loadeddata"));
  expect(video.style.opacity).toBe("");
  scanner.stop();
});

const settle = () => new Promise((r) => setTimeout(r, 10));

test("a camera that works again after an error says so", async () => {
  const camera = fakeCamera();
  camera.getUserMedia.mockRejectedValueOnce(new DOMException("x", "NotReadableError"));
  const video = document.createElement("video");
  const onError = vi.fn();
  const onReady = vi.fn();
  const scanner = startScanner(video, () => {}, { onError, onReady });
  await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  expect(onReady).not.toHaveBeenCalled();
  setVisibility("hidden");
  setVisibility("visible");
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  scanner.stop();
});

test("a refused or missing camera is not asked for again on every return", async () => {
  for (const name of ["NotAllowedError", "NotFoundError"]) {
    const camera = fakeCamera();
    camera.getUserMedia.mockRejectedValueOnce(new DOMException("x", name));
    const onError = vi.fn();
    const scanner = startScanner(document.createElement("video"), () => {}, { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1);
    scanner.stop();
  }
});

test("a track that keeps ending is reopened once, then reported; a return to the app tries again", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const onError = vi.fn();
  const scanner = startScanner(video, () => {}, { onError });
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    camera.tracks[0]?.ended();
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1); // waits first: the page may be about to hide
    await vi.advanceTimersByTimeAsync(ENDED_WAIT_MS);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(video.srcObject).not.toBeNull());

    camera.tracks[1]?.ended();
    expect(onError).not.toHaveBeenCalled(); // the same grace as the first end
    await vi.advanceTimersByTimeAsync(ENDED_WAIT_MS * 4);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/stopped/));
    expect(camera.open()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
  setVisibility("hidden");
  setVisibility("visible");
  await vi.waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(3));
  scanner.stop();
});

test("a track that ends as the app is left is not reopened or reported", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const onError = vi.fn();
  const scanner = startScanner(video, () => {}, { onError });
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    camera.tracks[0]?.ended();
    setVisibility("hidden"); // iOS can say so just after the track ends
    await vi.advanceTimersByTimeAsync(ENDED_WAIT_MS);
  } finally {
    vi.useRealTimers();
  }
  expect(camera.getUserMedia).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  scanner.stop();
});

test("a reopen that fails because the app was left meanwhile is not reported", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const onError = vi.fn();
  const scanner = startScanner(video, () => {}, { onError });
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  let reject: (e: unknown) => void = () => {};
  camera.getUserMedia.mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
  awayLong(camera);
  await vi.waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(2));
  setVisibility("hidden", false); // not yet announced
  reject(new DOMException("x", "NotReadableError"));
  await settle();
  expect(onError).not.toHaveBeenCalled();
  scanner.stop();
});

test("a frame read from before a reopen, or landing while hidden, is dropped", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  Object.defineProperty(video, "videoWidth", { value: 1280, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 720, configurable: true });
  const fakeCtx = { drawImage() {}, getImageData: () => ({}) };
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
  decoder.pending.length = 0;
  const onCode = vi.fn();
  const onError = vi.fn();
  const scanner = startScanner(video, onCode, { onError });
  try {
    await vi.waitFor(() => expect(decoder.pending).toHaveLength(1));
    awayLong(camera);
    decoder.pending.shift()?.("AAAAAAAAAA"); // the old frame lands after the reopen
    await settle();
    expect(onCode).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(decoder.pending.length).toBeGreaterThan(0));
    awayLong(camera);
    decoder.pending.shift()?.(new Error("old frame")); // and an old failure is dropped too
    await settle();
    expect(onError).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(decoder.pending.length).toBeGreaterThan(0));
    setVisibility("hidden");
    decoder.pending.shift()?.("CCCCCCCCCC"); // lands while the app is away
    await settle();
    expect(onCode).not.toHaveBeenCalled();
    setVisibility("visible");
    await settle();
    expect(onError).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(decoder.pending.length).toBeGreaterThan(0));
    decoder.pending.shift()?.("BBBBBBBBBB"); // a frame from the new stream
    await vi.waitFor(() => expect(onCode).toHaveBeenCalledWith("BBBBBBBBBB"));
  } finally {
    scanner.stop();
    getContext.mockRestore();
  }
});

test("a read before the picture settled still shows the frozen frame", async () => {
  fakeCamera();
  const video = document.createElement("video");
  video.requestVideoFrameCallback = () => 0; // no frame is ever presented
  video.cancelVideoFrameCallback = () => {};
  const playSpy = vi.spyOn(video, "play");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalled());
  await settle();
  expect(video.style.opacity).toBe("0");
  scanner.pause();
  expect(video.style.opacity).toBe("");
  scanner.stop();
});

test("the loadeddata wait is removed on release", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const removeSpy = vi.spyOn(video, "removeEventListener");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  awayLong(camera);
  expect(removeSpy).toHaveBeenCalledWith("loadeddata", expect.any(Function));
  scanner.stop();
});

test("a second track end while the app is being left is not reported", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const onError = vi.fn();
  const scanner = startScanner(video, () => {}, { onError });
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    camera.tracks[0]?.ended();
    await vi.advanceTimersByTimeAsync(ENDED_WAIT_MS);
    await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
    camera.tracks[1]?.ended();
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(ENDED_WAIT_MS);
  } finally {
    vi.useRealTimers();
  }
  expect(onError).not.toHaveBeenCalled();
  scanner.stop();
});

test("a track that ends long after the last reopen is reopened again", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const onError = vi.fn();
  const scanner = startScanner(video, () => {}, { onError });
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    camera.tracks[0]?.ended();
    await vi.advanceTimersByTimeAsync(ENDED_WAIT_MS);
    await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
    await vi.advanceTimersByTimeAsync(STABLE_MS);
    camera.tracks[1]?.ended();
    await vi.advanceTimersByTimeAsync(ENDED_WAIT_MS);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
  expect(onError).not.toHaveBeenCalled();
  scanner.stop();
});

test("a refusal raised while the app is being left does not stop the camera reopening on return", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const onError = vi.fn();
  const scanner = startScanner(video, () => {}, { onError });
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  let reject: (e: unknown) => void = () => {};
  camera.getUserMedia.mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
  awayLong(camera);
  await vi.waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(2));
  setVisibility("hidden", false);
  reject(new DOMException("x", "NotAllowedError"));
  await settle();
  setVisibility("hidden");
  setVisibility("visible");
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  expect(camera.getUserMedia).toHaveBeenCalledTimes(3);
  expect(onError).not.toHaveBeenCalled();
  scanner.stop();
});

test("a pause that interrupts a reopen's play is not a failure", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const onError = vi.fn();
  const onReady = vi.fn();
  const scanner = startScanner(video, () => {}, { onError, onReady });
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  vi.spyOn(video, "play").mockRejectedValueOnce(new DOMException("x", "AbortError"));
  awayLong(camera);
  scanner.pause();
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
  expect(onError).not.toHaveBeenCalled();
  expect(video.srcObject).not.toBeNull();
  scanner.stop();
});

test("a video that will not play is not reported as a refused camera, and is retried on return", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  vi.spyOn(video, "play").mockRejectedValueOnce(new DOMException("x", "NotAllowedError")); // autoplay blocked
  const onError = vi.fn();
  const scanner = startScanner(video, () => {}, { onError });
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("The camera could not start."));
  expect(camera.open()).toBe(0);
  setVisibility("hidden");
  setVisibility("visible");
  await vi.waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(2));
  scanner.stop();
});

test("a pending frame wait is cancelled on release", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  video.requestVideoFrameCallback = () => 7;
  const cancel = vi.fn();
  video.cancelVideoFrameCallback = cancel;
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  awayLong(camera);
  expect(cancel).toHaveBeenCalledWith(7);
  scanner.stop();
});

/** Back from a trip away with the track still live but muted, as iOS can leave it. */
async function backMuted() {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const playSpy = vi.spyOn(video, "play");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(1));
  video.style.opacity = ""; // as if the first frame had shown
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setVisibility("hidden");
  camera.tracks[0]?.mute();
  setVisibility("visible");
  return { camera, video, playSpy, scanner };
}

test("a muted track on return is hidden, then shown when it unmutes, not reopened", async () => {
  const { camera, video, scanner } = await backMuted();
  try {
    expect(video.style.opacity).toBe("0"); // black, so not shown
    camera.tracks[0]?.unmute();
    video.dispatchEvent(new Event("loadeddata")); // the fallback wait, with no requestVideoFrameCallback here
    expect(video.style.opacity).toBe("");
    await vi.advanceTimersByTimeAsync(UNMUTE_WAIT_MS * 2);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    scanner.stop();
  }
});

test("a track still muted after the wait is replaced by a new one", async () => {
  const { camera, video, scanner } = await backMuted();
  try {
    await vi.advanceTimersByTimeAsync(UNMUTE_WAIT_MS);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  expect(camera.open()).toBe(1);
  scanner.stop();
});

test("a track that mutes while in use is hidden and given the same wait", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  video.style.opacity = "";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    camera.tracks[0]?.mute(); // a call, or Siri
    expect(video.style.opacity).toBe("0");
    await vi.advanceTimersByTimeAsync(UNMUTE_WAIT_MS);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  expect(camera.open()).toBe(1);
  scanner.stop();
});

test("leaving during the unmute wait opens nothing while away, and stop ends the wait", async () => {
  const { camera, video, scanner } = await backMuted();
  try {
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(UNMUTE_WAIT_MS * 2);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1); // released, but not reopened while hidden
    expect(camera.open()).toBe(0);
    setVisibility("visible");
    await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
    expect(camera.getUserMedia).toHaveBeenCalledTimes(2);

    camera.tracks[1]?.mute();
    scanner.stop();
    await vi.advanceTimersByTimeAsync(UNMUTE_WAIT_MS * 2);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(2);
    expect(camera.open()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("leaving abandons an open that has not finished; the return starts a fresh one", async () => {
  const camera = fakeCamera();
  let reject: (e: unknown) => void = () => {};
  camera.getUserMedia.mockImplementationOnce(() => new Promise((_, r) => (reject = r))); // iOS never answers
  const video = document.createElement("video");
  const onError = vi.fn();
  const scanner = startScanner(video, () => {}, { onError });
  setVisibility("hidden");
  setVisibility("visible");
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  expect(camera.getUserMedia).toHaveBeenCalledTimes(2);

  reject(new DOMException("x", "NotAllowedError")); // the abandoned open fails late
  await settle();
  expect(onError).not.toHaveBeenCalled();
  awayLong(camera);
  await vi.waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(3)); // not given up
  scanner.stop();
});

test("a frame read before a short trip away is dropped when it lands after the return", async () => {
  fakeCamera();
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  Object.defineProperty(video, "videoWidth", { value: 1280, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 720, configurable: true });
  const fakeCtx = { drawImage() {}, getImageData: () => ({}) };
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
  decoder.pending.length = 0;
  const onCode = vi.fn();
  const scanner = startScanner(video, onCode);
  try {
    await vi.waitFor(() => expect(decoder.pending).toHaveLength(1));
    setVisibility("hidden");
    setVisibility("visible");
    decoder.pending.shift()?.("AAAAAAAAAA");
    await settle();
    expect(onCode).not.toHaveBeenCalled();
  } finally {
    scanner.stop();
    getContext.mockRestore();
  }
});

test("leaving pauses the video, and a longer absence frees the camera", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  const pauseSpy = vi.spyOn(video, "pause");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    setVisibility("hidden");
    expect(pauseSpy).toHaveBeenCalled();
    expect(camera.open()).toBe(1);
    await vi.advanceTimersByTimeAsync(AWAY_MS);
    expect(camera.open()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
  setVisibility("visible");
  await vi.waitFor(() => expect(camera.open()).toBe(1));
  scanner.stop();
});

test("the away timer firing as the page comes back does not free the camera", async () => {
  const camera = fakeCamera();
  const video = document.createElement("video");
  const scanner = startScanner(video, () => {});
  await vi.waitFor(() => expect(video.srcObject).not.toBeNull());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    setVisibility("hidden");
    setVisibility("visible", false); // iOS: visible again, the event not yet run, the suspended timer due
    await vi.advanceTimersByTimeAsync(AWAY_MS);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(camera.open()).toBe(1);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
  scanner.stop();
});

test("picking the stream up again on return says the camera is ready", async () => {
  fakeCamera();
  const video = document.createElement("video");
  const onReady = vi.fn();
  const scanner = startScanner(video, () => {}, { onReady });
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  setVisibility("hidden");
  setVisibility("visible");
  expect(onReady).toHaveBeenCalledTimes(2);
  scanner.stop();
});
