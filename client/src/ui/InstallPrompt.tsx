import { useEffect, useState } from "react";
import { type BeforeInstallPromptEvent, isInstalled, isIos } from "../lib/install";

const SNOOZE_KEY = "install-snoozed-until";
const SNOOZE_MS = 24 * 3_600_000;

function snoozed(): boolean {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY)) > Date.now();
  } catch {
    return false;
  }
}

/** Why we nag: a browser tab loses its storage after 7 days unvisited on iOS; an installed app does not (NFR-DEP-06). */
export function InstallPrompt() {
  const [hidden, setHidden] = useState(() => isInstalled() || snoozed());
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

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
      <strong>Add to your home screen.</strong> In a browser tab, the phone deletes unsent records after 7 days without
      a visit. An installed app keeps them.
      {prompt ? (
        <button className="primary" onClick={() => prompt.prompt().then(() => setHidden(true))}>
          Install
        </button>
      ) : (
        isIos() && <p className="muted">Tap Share, then “Add to Home Screen”.</p>
      )}
      <button onClick={later}>Not now</button>
    </aside>
  );
}
