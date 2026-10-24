import { useState } from "react";
import { isHttpsLink, isInstalled, isIos, isIphone } from "../lib/install";
import { NATIVE } from "../lib/server";

const SNOOZE_KEY = "install-snoozed-until";
// Its own key: a Not now given to the home-screen hint must not hide the app's link.
const APP_SNOOZE_KEY = "app-snoozed-until";
const SNOOZE_MS = 24 * 3_600_000;

function snoozed(key: string): boolean {
  try {
    return Number(localStorage.getItem(key)) > Date.now();
  } catch {
    return false;
  }
}

/**
 * Why we nag, and only on iOS: the browser loses a tab's storage after 7 days
 * unvisited; an installed app does not (NFR-DEP-06). Android has no such rule,
 * so it is never asked. An iPhone is sent to the group's app when it has one,
 * from the home screen too (NFR-DEP-12). Only the signed-in shell renders
 * this, so a finder never sees it (NFR-DEP-13).
 */
export function InstallPrompt({ appUrl }: { appUrl?: string | null }) {
  const [dismissed, setDismissed] = useState(false);
  // The server checks the link too; this keeps a bad one from becoming a live link.
  const app = isIphone() && appUrl != null && isHttpsLink(appUrl);
  const key = app ? APP_SNOOZE_KEY : SNOOZE_KEY;

  // From the home screen, storage is safe; only the app is still worth offering.
  const installed = isInstalled();
  if (dismissed || !isIos() || NATIVE || (installed && !app) || snoozed(key)) return null;

  function later() {
    try {
      localStorage.setItem(key, String(Date.now() + SNOOZE_MS));
    } catch {
      // Private mode. The prompt will just come back.
    }
    setDismissed(true);
  }

  // Small on purpose: the App Store page says Open when the app is already there, which no web page can know.
  if (app) {
    return (
      <aside className="notice notice-row">
        <span>There’s an iPhone app.</span>
        <a href={appUrl}>App Store</a>
        <button type="button" className="minor" onClick={later}>
          Not now
        </button>
      </aside>
    );
  }

  return (
    <aside className="notice">
      <strong>Add to your home screen.</strong> Safari clears a tab’s storage after seven days without a visit to the
      site, and unsent records go with it. An installed app is exempt.
      <p className="muted">
        Do it before you record anything. The installed app has storage of its own: it opens signed out and empty, and
        whatever is in this tab stays in this tab until it syncs.
      </p>
      <p className="muted">Tap Share, then “Add to Home Screen”.</p>
      <button onClick={later}>Not now</button>
    </aside>
  );
}
