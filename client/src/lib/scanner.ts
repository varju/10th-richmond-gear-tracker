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
  onError?: (message: string) => void;
}

export interface Scanner {
  stop(): void;
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
  { tryHarder = false, onError }: ScannerOptions = {},
): Scanner {
  let stream: MediaStream | null = null;
  let stopped = false;
  let frame = 0;
  let decoding = false;
  const debounce = new Debounce();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const fail = (message: string) => onError?.(message);

  const tick = () => {
    if (stopped) return;
    frame = requestAnimationFrame(tick);
    if (decoding || !ctx || video.readyState < video.HAVE_CURRENT_DATA || !video.videoWidth) return;
    const scale = DECODE_WIDTH / video.videoWidth;
    canvas.width = DECODE_WIDTH;
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
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
  };
}
