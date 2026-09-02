/**
 * One breakpoint, named once. Below it the phone layout, unchanged; above it
 * the desk (NFR-USE-10). Most of the difference is CSS in styles.css, which
 * repeats this width. Screens whose shape cannot come from CSS ask useWide().
 */
import { useSyncExternalStore } from "react";

export const WIDE = "(min-width: 900px)";

const query = (): MediaQueryList => window.matchMedia(WIDE);

function subscribe(listener: () => void): () => void {
  const list = query();
  list.addEventListener("change", listener);
  return () => list.removeEventListener("change", listener);
}

/** True at a table, false at a locker. */
export const useWide = (): boolean => useSyncExternalStore(subscribe, () => query().matches);
