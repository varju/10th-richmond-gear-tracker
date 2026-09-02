/** Is this running from a home-screen icon (NFR-DEP-06)? */
export function isInstalled(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

/**
 * A phone or a tablet. The install nag exists for the 7-day clearing and for a
 * locker; a desktop has neither, so it never sees it.
 */
export function isHandheld(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches === true;
}

/** Chromium fires this before its own install prompt; we hold it and show ours. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
