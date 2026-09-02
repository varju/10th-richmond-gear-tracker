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

/** Chromium fires this before its own install prompt; we hold it and show ours. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
