import { useState } from "react";
import { entryState, setEntryState } from "../lib/router";

/**
 * Folds opened or shut by hand, kept with the history entry so Back brings them back.
 * One set while browsing, another while a search or filter narrows the list.
 */
export function useFolds(narrowed: boolean) {
  const [, refold] = useState(0);
  const looking = narrowed ? "narrowed" : "all";
  const folds = (key: string) =>
    ((entryState(key) as Record<string, Record<string, boolean>> | undefined) ?? {})[looking] ?? {};
  const setFolds = (key: string, ids: string[], value: boolean) => {
    const all = (entryState(key) ?? {}) as Record<string, Record<string, boolean>>;
    setEntryState(key, { ...all, [looking]: { ...all[looking], ...Object.fromEntries(ids.map((id) => [id, value])) } });
    refold((n) => n + 1);
  };
  return { folds, setFolds };
}
