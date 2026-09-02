import { useSyncExternalStore } from "react";
import type { Store } from "./lib/store";

/** Re-render when the store changes. */
export function useStore(store: Store): number {
  return useSyncExternalStore(store.subscribe, () => store.version);
}
