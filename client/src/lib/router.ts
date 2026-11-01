/**
 * Paths, not hashes: a sticker's URL is /g/<code>, and the server hands
 * index.html to any path it does not own. A small router beats a dependency.
 *
 * The app may be served under a path rather than at a domain root, so every
 * route in the code is written without one. BASE is added on the way out and
 * taken off on the way in, here and nowhere else.
 */
import { useSyncExternalStore } from "react";

export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const listeners = new Set<() => void>();

/** What we keep in `history.state`: how many steps into the app this entry is, which entry it is, and its scroll when left. */
interface Entry {
  depth: number;
  key?: string;
  scroll?: number;
}

const current = (): Entry | null => history.state as Entry | null;

/** A fresh load, or a link from outside, is 0. Anything the app pushed is deeper. */
export function depth(): number {
  const state = current();
  return typeof state?.depth === "number" ? state.depth : 0;
}

export function navigate(path: string, replace = false): void {
  const href = BASE + path;
  // A replace on the same screen (a search as it is typed) keeps its place; anything else starts at the top.
  const same = replace && parseRoute(location.pathname).path === parseRoute(path, "").path;
  restoring?.();
  if (same) history.replaceState({ ...current(), depth: depth() }, "", href);
  else if (replace) history.replaceState({ depth: depth(), key: newKey() }, "", href);
  else {
    history.replaceState({ ...current(), depth: depth(), key: key(), scroll: window.scrollY }, "");
    history.pushState({ depth: depth() + 1, key: newKey() }, "", href);
  }
  for (const listener of listeners) listener();
  if (!same) window.scrollTo(0, 0);
}

/** Back: the way the person came, or `fallback` when they arrived here cold. */
export function back(fallback: string): void {
  if (depth() > 0) history.back();
  else navigate(fallback, true);
}

// By hand: the browser restores scroll before the screen behind has rendered.
history.scrollRestoration = "manual";

let keys = 0;
const newKey = () => `${Date.now()}-${keys++}`;

function key(): string {
  const state = current();
  if (state?.key) return state.key;
  const fresh = newKey();
  history.replaceState({ ...state, depth: depth(), key: fresh }, "");
  return fresh;
}

const positions = new Map<string, number>();
const INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** Stops a restore in progress; set only while one runs. */
let restoring: (() => void) | null = null;

export const restoringScroll = (): boolean => restoring !== null;

// Content can arrive late (the store loading, history from the server), so try again as the page
// grows. Give up once the person touches anything, or after ten seconds.
function restore(y: number): void {
  restoring?.();
  const observer = new ResizeObserver(() => attempt());
  const timer = setTimeout(() => stop(), 10_000);
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of INPUT) window.removeEventListener(type, stop);
    if (restoring === stop) restoring = null;
  };
  const attempt = () => {
    if (restoring !== stop) return;
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) < 1) stop();
  };
  restoring = stop;
  for (const type of INPUT) window.addEventListener(type, stop, { passive: true });
  observer.observe(document.body);
  requestAnimationFrame(attempt);
}

const record = () => {
  if (!restoring) positions.set(key(), window.scrollY);
};
window.addEventListener("scroll", record, { passive: true });
// A link to a heading on the page (the guide's contents) is the browser's to scroll.
window.addEventListener("popstate", () => {
  if (!location.hash) restore(positions.get(key()) ?? current()?.scroll ?? 0);
});
window.addEventListener("pagehide", () => history.replaceState({ ...current(), scroll: window.scrollY }, ""));
if (current()?.scroll) restore(current()!.scroll!);

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
