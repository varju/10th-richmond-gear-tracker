import { NATIVE } from "./server";

/** Is this running from a home-screen icon (NFR-DEP-06)? The iPhone app always is. */
export function isInstalled(): boolean {
  return (
    NATIVE ||
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/** The only platform with the 7-day clearing, so the only one the install nag is for. */
export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

/** The iPhone app is for iPhone only, so an iPad is not sent to it (NFR-DEP-12). Any iPhone browser clears storage. */
export function isIphone(): boolean {
  return /iPhone/.test(navigator.userAgent);
}

/**
 * The server's rule for the iPhone app link, the same pattern as events.HTTPS_LINK: https://, in any case, a host,
 * and no spaces or control characters. Not a URL parser: the server's would disagree at the edges.
 */
const HTTPS_LINK = /^https:\/\/[^\x00-\x20/?#]+(?:[/?#][^\x00-\x20]*)?$/i;

export const isHttpsLink = (value: string): boolean => HTTPS_LINK.test(value);
