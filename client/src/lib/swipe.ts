/**
 * The iPhone app's edge swipe back (NFR-USE-13), off while a form holds unsaved changes: the swipe
 * would skip the question Back asks (ios/App/App/MainViewController.swift). Does nothing on the web.
 */
import { NATIVE } from "./server";
import { unsaved } from "./unsaved";

export function startSwipe(bridge = window.Capacitor, native = NATIVE): () => void {
  if (!native || !bridge) return () => {};
  let on: boolean | null = null;
  // At start too: the web view outlives a page reload, and may still hold the swipe off.
  const send = () => {
    const next = !unsaved.any;
    if (next === on) return;
    on = next;
    bridge.nativePromise("SwipePlugin", "set", { on }).catch(() => {
      // A build without the plugin keeps the swipe as it is.
    });
  };
  send();
  return unsaved.subscribe(send);
}
