import { useState } from "react";
import { isInstalled, isIos } from "../lib/install";

const SNOOZE_KEY = "install-snoozed-until";
const SNOOZE_MS = 24 * 3_600_000;

function snoozed(): boolean {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY)) > Date.now();
  } catch {
    return false;
  }
}

/**
 * Why we nag, and only on iOS: Safari loses a tab's storage after 7 days
 * unvisited; an installed app does not (NFR-DEP-06). Android has no such rule,
 * so it is never asked.
 */
export function InstallPrompt() {
  const [hidden, setHidden] = useState(() => !isIos() || isInstalled() || snoozed());

  if (hidden) return null;

  function later() {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    } catch {
      // Private mode. The prompt will just come back.
    }
    setHidden(true);
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
