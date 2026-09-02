import { createContext, useContext } from "react";
import type { SyncOutcome } from "./lib/sync";

/** What every screen may need from the app around it. */
export interface Shell {
  busy: boolean;
  outcome: SyncOutcome | null;
  now: () => number;
  /** Ask for a sync now. Answers `undefined` if one is already running. */
  sync: () => Promise<SyncOutcome | undefined>;
  signOut: () => Promise<void>;
}

export const ShellContext = createContext<Shell>({
  busy: false,
  outcome: null,
  now: Date.now,
  sync: async () => undefined,
  signOut: async () => {},
});

export const useShell = () => useContext(ShellContext);
