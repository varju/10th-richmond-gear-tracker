/**
 * Paths, not hashes: a sticker's URL is /g/<code>, and the server hands
 * index.html to any path it does not own. Thirty lines beat a dependency.
 */
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

export function useRoute(): Route {
  const href = useSyncExternalStore(subscribe, () => location.pathname + location.search);
  return parseRoute(href);
}

export function parseRoute(href: string): Route {
  const url = new URL(href, "http://x");
  return { path: url.pathname, segments: url.pathname.split("/").filter(Boolean), query: url.searchParams };
}
