import { createContext, useContext } from "react";
import type { Api } from "./lib/api";
import type { Store } from "./lib/store";
import type { SyncOutcome } from "./lib/sync";

/** What every screen may need from the app around it. */
export interface Shell {
  busy: boolean;
  /**
   * True only while a sync the person started (the Sync now button, not the
   * background poll) is running. A button that disables while busy should
   * disable on this, not on `busy`, or it flickers every time the poll fires.
   */
  manualBusy: boolean;
  outcome: SyncOutcome | null;
  now: () => number;
  /** Ask for a sync now. Answers `undefined` if one is already running. */
  sync: () => Promise<SyncOutcome | undefined>;
  /** Same, but marks `manualBusy` for the button that started it. */
  syncNow: () => Promise<SyncOutcome | undefined>;
  signOut: () => Promise<void>;
  /** For the few screens that talk to the server directly, such as photos. Absent means offline. */
  api?: Api;
  /** Absent before sign-in: the public sticker page runs with no app around it. */
  store?: Store;
}

export const ShellContext = createContext<Shell>({
  busy: false,
  manualBusy: false,
  outcome: null,
  now: Date.now,
  sync: async () => undefined,
  syncNow: async () => undefined,
  signOut: async () => {},
});

export const useShell = () => useContext(ShellContext);
