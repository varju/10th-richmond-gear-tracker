/**
 * The camera and the decoder. Frames come off a getUserMedia stream, are
 * drawn at 640 px wide, and go to zxing-wasm in fast mode: 3–7 ms a frame on
 * the phones M0 measured (architecture.md, "What M0 measured").
 *
 * The .wasm is bundled and precached, so this works in a locker with no signal.
 */
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
  },
});

export const DECODE_WIDTH = 640;
export const REPEAT_MS = 1500;
/** How far past the target box a code may sit and still be read: 1.5 means a region half again the box's size. */
export const TARGET_ROOM = 1.5;

export interface Size {
  w: number;
  h: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The part of the camera frame to decode: the target box with some room around it, in frame pixels.
 *
 * The video is shown with `object-fit: cover`, so the frame is scaled to fill the element and the overflow is
 * cut off. Without this, the decoder saw that cut-off overflow too, and read stickers that were not on the
 * screen at all. `box` is the target's rectangle within the shown element; null, or an element with no size
 * yet, means the whole frame.
 */
export function cropFor(frame: Size, shown: Size, box: Box | null, room = TARGET_ROOM): Box {
  const whole = { x: 0, y: 0, w: frame.w, h: frame.h };
  if (!box || shown.w <= 0 || shown.h <= 0 || box.w <= 0 || box.h <= 0) return whole;
  const scale = Math.max(shown.w / frame.w, shown.h / frame.h); // cover: the larger ratio fills the element
  const offsetX = (frame.w - shown.w / scale) / 2; // frame pixels cut off on the left
  const offsetY = (frame.h - shown.h / scale) / 2;
  const centreX = offsetX + (box.x + box.w / 2) / scale;
  const centreY = offsetY + (box.y + box.h / 2) / scale;
  const w = (box.w / scale) * room;
  const h = (box.h / scale) * room;
  const x = Math.max(0, Math.round(centreX - w / 2));
  const y = Math.max(0, Math.round(centreY - h / 2));
  return { x, y, w: Math.min(frame.w - x, Math.round(w)), h: Math.min(frame.h - y, Math.round(h)) };
}

/** The same text is reported once per window, so one sticker does not fire thirty times a second. */
export class Debounce {
  private last: { text: string; at: number } | null = null;

  constructor(private windowMs = REPEAT_MS) {}

  accept(text: string, now: number): boolean {
    if (this.last && this.last.text === text && now - this.last.at < this.windowMs) return false;
    this.last = { text, at: now };
    return true;
  }
}

export interface ScannerOptions {
  /** Slower, more forgiving decode. Off by default; M0 found it unnecessary. */
  tryHarder?: boolean;
  /** The target box drawn over the video. Only the frame around it is decoded (see `cropFor`). */
  target?: () => Element | null;
  onError?: (message: string) => void;
  /** The camera opened, including after an error: clear what `onError` showed. */
  onReady?: () => void;
}

export interface Scanner {
  stop(): void;
  /** Freeze on the current frame: a read looks like a read. The camera stays open. */
  pause(): void;
  /** Un-freeze after `pause()`. */
  resume(): void;
}

/**
 * A short buzz to confirm a read. Android only: iOS Safari has no Vibration API, and the hidden-switch
 * trick some libraries use (toggle an `<input switch>` from script) was tried on an iPhone in September
 * 2026 and buzzed nothing, in Safari or from the home screen. The flash and the click are what iOS gets.
 */
export function vibrate(): void {
  navigator.vibrate?.(30);
}

/** How long the read flash shows: the target goes green and the rest of the frame dims. */
export const READ_MS = 300;

let sound: AudioContext | null = null;

/**
 * Let the page make a sound. iOS will not start audio outside a tap, so call this from one:
 * the scan screens call it on mount (React runs that inside the tap that opened them) and on
 * every tap while open, so the first read of a session is not silent.
 */
export function unlockSound(): void {
  if (typeof AudioContext === "undefined") return;
  sound ??= new AudioContext();
  if (sound.state === "suspended") void sound.resume().catch(() => {});
}

/** A short click, where sound is unlocked. Quiet otherwise; never an error. */
export function click(): void {
  if (!sound || sound.state !== "running") return;
  const at = sound.currentTime;
  const osc = sound.createOscillator();
  const gain = sound.createGain();
  osc.frequency.value = 1400;
  gain.gain.setValueAtTime(0.25, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.08);
  osc.connect(gain).connect(sound.destination);
  osc.start(at);
  osc.stop(at + 0.09);
}

/** What a phone can do to say "got it": a buzz where there is a Vibration API, a click where sound is unlocked. */
export function confirmRead(): void {
  vibrate();
  click();
}

function shownSize(video: HTMLVideoElement): Size {
  return { w: video.clientWidth, h: video.clientHeight };
}

/** The target's rectangle relative to the video element, or null when there is no target to aim at. */
function targetBox(video: HTMLVideoElement, target?: () => Element | null): Box | null {
  const el = target?.();
  if (!el) return null;
  const t = el.getBoundingClientRect();
  const v = video.getBoundingClientRect();
  return { x: t.left - v.left, y: t.top - v.top, w: t.width, h: t.height };
}

/** Why the camera could not start, in words a person can act on. */
export function cameraError(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError")
    return "Camera access was refused. Allow it in the browser settings, or type the code.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found on this device.";
  if (name === "NotReadableError") return "The camera is in use by another app.";
  return "The camera could not start.";
}

/** Frames to wait for one at the stream's settled size before showing the video anyway. */
const SETTLE_FRAMES = 10;
/** How long to wait after a track ends before reopening: iOS can end it just before the page says it is hidden. */
export const ENDED_WAIT_MS = 500;
/** A track that ends this soon after the last reopen for an end is reported, not reopened again. */
export const STABLE_MS = 60_000;

/** getUserMedia errors a retry will not fix. After one, the camera is not tried again on this screen. */
const PERMANENT = new Set(["NotAllowedError", "NotFoundError", "OverconstrainedError"]);

const errorName = (e: unknown) => (e instanceof Error ? e.name : "");

/**
 * Start the camera into `video` and call `onCode` for each code seen. Call `stop()` before the screen goes away.
 *
 * iOS stops the capture when the app is left, so the camera is released while the page is hidden and opened again
 * when it comes back. A track that ends on its own is reopened, unless it last did so under `STABLE_MS` ago.
 */
export function startScanner(
  video: HTMLVideoElement,
  onCode: (text: string) => void,
  { tryHarder = false, target, onError, onReady }: ScannerOptions = {},
): Scanner {
  let stream: MediaStream | null = null;
  let stopped = false;
  let paused = false;
  let running = false; // the camera has opened at least once
  let frame = 0;
  let decoding = false;
  let current: object | null = null; // the open in flight or live; a stale open or frame compares and backs out
  let gaveUp = false;
  let endedAt = -Infinity; // when a track end last caused a reopen
  let endedTimer: ReturnType<typeof setTimeout> | undefined;
  let unshow = () => {};
  const debounce = new Debounce();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const fail = (message: string) => onError?.(message);
  const visible = () => document.visibilityState !== "hidden";

  const tick = () => {
    if (stopped || paused) return;
    frame = requestAnimationFrame(tick);
    if (decoding || !ctx || video.readyState < video.HAVE_CURRENT_DATA || !video.videoWidth) return;
    const crop = cropFor({ w: video.videoWidth, h: video.videoHeight }, shownSize(video), targetBox(video, target));
    // Never upscale: a crop smaller than DECODE_WIDTH is decoded at its own size.
    const scale = Math.min(1, DECODE_WIDTH / crop.w);
    canvas.width = Math.round(crop.w * scale);
    canvas.height = Math.round(crop.h * scale);
    ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const mine = current;
    // A frame from before a release is dropped: the person may have aimed elsewhere since.
    const live = () => !stopped && mine === current;
    decoding = true;
    readBarcodes(image, { formats: ["QRCode"], tryHarder, maxNumberOfSymbols: 1 })
      .then((results) => {
        const text = results[0]?.text;
        if (live() && text && debounce.accept(text, Date.now())) onCode(text);
      })
      .catch((e: unknown) => {
        if (live()) fail(e instanceof Error ? e.message : "Decoder failed.");
      })
      .finally(() => {
        decoding = false;
      });
  };

  const loop = () => {
    cancelAnimationFrame(frame);
    if (stream && !paused && !stopped) frame = requestAnimationFrame(tick);
  };

  // WebKit draws the first frames narrower, with black bars, before object-fit: cover takes hold. The viewfinder
  // is black behind the video, so keep the video see-through until a frame at the stream's settled size is shown.
  // Only the picture waits: decoding runs from the start.
  const hideVideo = () => {
    video.style.opacity = "0";
  };
  const showVideo = () => {
    video.style.opacity = "";
  };
  const showWhenSettled = () => {
    if (typeof video.requestVideoFrameCallback !== "function") {
      video.addEventListener("loadeddata", showVideo, { once: true });
      unshow = () => video.removeEventListener("loadeddata", showVideo);
      return;
    }
    let seen = 0;
    let handle = 0;
    const wait: VideoFrameRequestCallback = (_now, meta) => {
      seen += 1;
      if ((meta.width === video.videoWidth && meta.height === video.videoHeight) || seen >= SETTLE_FRAMES) showVideo();
      else handle = video.requestVideoFrameCallback(wait);
    };
    handle = video.requestVideoFrameCallback(wait);
    unshow = () => video.cancelVideoFrameCallback(handle);
  };

  const release = () => {
    current = null;
    clearTimeout(endedTimer);
    cancelAnimationFrame(frame);
    unshow();
    unshow = () => {};
    stream?.getTracks().forEach((t) => {
      t.removeEventListener("ended", onEnded);
      t.stop();
    });
    stream = null;
    video.srcObject = null;
    hideVideo();
  };

  // Failures while the app is being left are iOS taking the camera, not faults: they are not reported, and coming
  // back retries.
  const open = async () => {
    const mine = {};
    current = mine;
    const stale = () => stopped || mine !== current;
    let got: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("no camera", "NotFoundError");
      got = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
        audio: false,
      });
    } catch (e: unknown) {
      if (stale()) return;
      current = null;
      if (!visible()) return;
      gaveUp = PERMANENT.has(errorName(e));
      return fail(cameraError(e));
    }
    if (stale()) return got.getTracks().forEach((t) => t.stop());
    stream = got;
    got.getTracks().forEach((t) => t.addEventListener("ended", onEnded));
    video.muted = true;
    video.playsInline = true;
    video.srcObject = got;
    showWhenSettled();
    try {
      // Coming back with the card up, the frozen frame went with the old stream. A live picture behind the card
      // beats a black one, so the video plays; the decode loop waits for resume().
      await video.play();
    } catch (e: unknown) {
      if (stale()) return;
      // AbortError: pause() interrupted the play. The stream is fine.
      if (errorName(e) !== "AbortError") {
        release();
        if (visible()) fail("The camera could not start.");
        return;
      }
    }
    if (stale()) return;
    running = true;
    onReady?.();
    loop();
  };

  const reopen = () => {
    if (stopped || gaveUp || current || !visible()) return;
    void open();
  };

  function onEnded() {
    release();
    endedTimer = setTimeout(() => {
      if (stopped || !visible()) return; // coming back reopens
      if (Date.now() - endedAt < STABLE_MS) return fail("The camera stopped. Leave the screen and open it again.");
      endedAt = Date.now();
      reopen();
    }, ENDED_WAIT_MS);
  }

  const onVisibility = () => {
    if (!visible()) return release();
    endedAt = -Infinity;
    reopen();
  };

  hideVideo();
  document.addEventListener("visibilitychange", onVisibility);
  reopen();

  return {
    stop() {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    },
    pause() {
      if (!running || stopped || paused) return;
      paused = true;
      cancelAnimationFrame(frame);
      video.pause();
      // A paused video presents no frames, so the settle wait would never end. The frame a read froze on is real.
      if (stream) showVideo();
    },
    resume() {
      if (!running || stopped || !paused) return;
      paused = false;
      // A rejected play() (interrupted by a fast pause/resume) is not a failure worth showing.
      if (stream) video.play().catch(() => {});
      loop();
    },
  };
}
