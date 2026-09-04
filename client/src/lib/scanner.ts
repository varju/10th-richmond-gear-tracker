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

/** Start the camera into `video` and call `onCode` for each code seen. Call `stop()` before the screen goes away. */
export function startScanner(
  video: HTMLVideoElement,
  onCode: (text: string) => void,
  { tryHarder = false, target, onError }: ScannerOptions = {},
): Scanner {
  let stream: MediaStream | null = null;
  let stopped = false;
  let paused = false;
  let running = false; // the camera is open and the decode loop has run at least one frame
  let frame = 0;
  let decoding = false;
  const debounce = new Debounce();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const fail = (message: string) => onError?.(message);

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
    decoding = true;
    readBarcodes(image, { formats: ["QRCode"], tryHarder, maxNumberOfSymbols: 1 })
      .then((results) => {
        const text = results[0]?.text;
        if (!stopped && text && debounce.accept(text, Date.now())) onCode(text);
      })
      .catch((e: unknown) => fail(e instanceof Error ? e.message : "Decoder failed."))
      .finally(() => {
        decoding = false;
      });
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("no camera", "NotFoundError");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
      audio: false,
    });
    if (stopped) return release();
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    if (stopped) return release();
    running = true;
    frame = requestAnimationFrame(tick);
  };

  const release = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  };

  start().catch((e: unknown) => {
    if (!stopped) fail(cameraError(e));
  });

  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(frame);
      release();
    },
    pause() {
      if (!running || stopped || paused) return;
      paused = true;
      cancelAnimationFrame(frame);
      video.pause();
    },
    resume() {
      if (!running || stopped || !paused) return;
      paused = false;
      // A rejected play() (interrupted by a fast pause/resume) is not a failure worth showing.
      video.play().catch(() => {});
      frame = requestAnimationFrame(tick);
    },
  };
}
