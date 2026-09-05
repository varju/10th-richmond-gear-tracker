/** Is this running from a home-screen icon (NFR-DEP-06)? */
export function isInstalled(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/** The only platform with the 7-day clearing, so the only one the install nag is for. */
export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}
