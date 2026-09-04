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

export function isAndroid(): boolean {
  return /Android/.test(navigator.userAgent);
}

/** Samsung's own Chromium browser, the default on Samsung phones. Its menu wording differs from Chrome's. */
export function isSamsungInternet(): boolean {
  return /SamsungBrowser/.test(navigator.userAgent);
}

/** What to call the browser in prose. iOS is Safari underneath no matter which app icon was tapped; elsewhere we cannot tell, so we say "Your browser". */
export function browserName(): string {
  return isIos() ? "Safari" : "Your browser";
}

/**
 * Steps for a non-iOS handheld browser that never fired `beforeinstallprompt`
 * (Firefox for Android never does; Samsung Internet often does not).
 */
export function nonIosInstallSteps(): string {
  if (isSamsungInternet()) return "Open the menu, tap “Add page to”, then “Home screen”.";
  if (isAndroid()) return "Open the ⋮ menu, then tap “Add to Home screen” or “Install app”.";
  return "Open your browser’s menu and choose “Add to Home screen”.";
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
