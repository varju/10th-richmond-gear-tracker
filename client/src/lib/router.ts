/**
 * Paths, not hashes: a sticker's URL is /g/<code>, and the server hands
 * index.html to any path it does not own. Thirty lines beat a dependency.
 *
 * The app may be served under a path rather than at a domain root, so every
 * route in the code is written without one. BASE is added on the way out and
 * taken off on the way in, here and nowhere else.
 */
import { useSyncExternalStore } from "react";

export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const listeners = new Set<() => void>();

/** What we keep in `history.state`: how many steps into the app this entry is. */
interface Entry {
  depth: number;
}

/** A fresh load, or a link from outside, is 0. Anything the app pushed is deeper. */
export function depth(): number {
  const state = history.state as Entry | null;
  return typeof state?.depth === "number" ? state.depth : 0;
}

export function navigate(path: string, replace = false): void {
  const href = BASE + path;
  const entry: Entry = { depth: replace ? depth() : depth() + 1 };
  if (replace) history.replaceState(entry, "", href);
  else history.pushState(entry, "", href);
  for (const listener of listeners) listener();
}

/** Back: the way the person came, or `fallback` when they arrived here cold. */
export function back(fallback: string): void {
  if (depth() > 0) history.back();
  else navigate(fallback, true);
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

export function parseRoute(href: string, base = BASE): Route {
  const url = new URL(href, "http://x");
  const path = strip(url.pathname, base);
  return {
    path,
    segments: path.split("/").filter(Boolean),
    query: url.searchParams,
  };
}

function strip(pathname: string, base: string): string {
  if (!base || !pathname.startsWith(base)) return pathname;
  return pathname.slice(base.length) || "/";
}
