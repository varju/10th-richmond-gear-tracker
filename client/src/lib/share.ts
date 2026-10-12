/**
 * What the iPhone app's WKWebView will not do as a browser does: download a file,
 * open a new window, or print. Each has a stand-in here, used only when `NATIVE`.
 */
import { NATIVE } from "./server";

/** The bridge Capacitor injects into the app's page. Its print call is ios/App/App/MainViewController.swift. */
declare global {
  interface Window {
    Capacitor?: { nativePromise(plugin: string, method: string, options: object): Promise<unknown> };
  }
}

/** `window.print()`, in the browser or the app. Rejects when the app cannot print, so the caller can say so. */
export async function printPage(native = NATIVE): Promise<void> {
  if (!native) return window.print();
  const bridge = window.Capacitor;
  if (!bridge) throw new Error("This app cannot print.");
  await bridge.nativePromise("PrintPlugin", "print", {});
}

/**
 * A file the web app would download goes to the share sheet: Save to Files, Print, Mail.
 * Rejects when the sheet is refused, as it is once the tap is too long ago; offer a button to try again.
 */
export async function shareFile(blob: Blob, name: string): Promise<void> {
  try {
    await navigator.share({ files: [new File([blob], name, { type: blob.type })] });
  } catch (e) {
    // The person closed the sheet. Nothing went wrong.
    if (e instanceof DOMException && e.name === "AbortError") return;
    throw e;
  }
}

/** What to say when the share sheet did not open. */
export const NOT_SHARED = "The share sheet did not open. Tap Share to try again.";
