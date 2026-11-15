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

/** What we keep in `history.state`: how many steps into the app this entry is, and which entry it is. */
interface Entry {
  depth: number;
  key?: string;
  screen?: Record<string, unknown>;
}

const current = (): Entry | null => history.state as Entry | null;

/** A fresh load, or a link from outside, is 0. Anything the app pushed is deeper. */
export function depth(): number {
  const state = current();
  return typeof state?.depth === "number" ? state.depth : 0;
}

export const hrefOf = (path: string): string => BASE + path;

export function navigate(path: string, replace = false): void {
  const href = hrefOf(path);
  // A replace on the same screen (a search as it is typed) keeps its place; anything else starts at the top.
  const same = replace && parseRoute(location.pathname).path === parseRoute(path, "").path;
  // Now, not on the scroll event: the browser sends that a frame late. Saved too, as the app's page may
  // be killed with no pagehide.
  if (!replace) {
    record();
    save();
  }
  restoring?.stop();
  if (same) history.replaceState({ ...current(), depth: depth() }, "", href);
  else if (replace) history.replaceState({ depth: depth(), key: newKey() }, "", href);
  else {
    history.replaceState({ ...current(), depth: depth(), key: key() }, "");
    history.pushState({ depth: depth() + 1, key: newKey() }, "", href);
  }
  shown = here();
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

/**
 * Each entry's scroll when left, by key. Kept for the tab, not in `history.state`: Back and Forward
 * can write only the entry they land on, and a reload would lose the one they left.
 */
const positions = new Map<string, number>();
const SCROLLS = "router.scroll";
const KEPT = 100;

function load(): void {
  positions.clear();
  try {
    for (const [entry, y] of JSON.parse(sessionStorage.getItem(SCROLLS) ?? "[]") as [string, number][])
      positions.set(entry, y);
  } catch {
    // No storage: positions last as long as the page.
  }
}
load();

function save(): void {
  try {
    sessionStorage.setItem(SCROLLS, JSON.stringify([...positions]));
  } catch {
    // As above.
  }
}
const INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
const maxScroll = () => document.documentElement.scrollHeight - window.innerHeight;

/** The restore in progress: where it is heading, and how to stop it. */
let restoring: { y: number; stop: () => void; scrolled: () => void } | null = null;

export const restoringScroll = (): boolean => restoring !== null;

// Content can arrive late (the store loading, history from the server), so try again as the page
// grows. Give up once the person touches anything or scrolls, or after ten seconds.
function restore(y: number): void {
  restoring?.stop();
  /** Where the last attempt left the page, short of `y` only when the page cannot yet reach it. */
  let placed: { y: number; max: number } | null = null;
  const observer = new ResizeObserver(() => attempt());
  const timer = setTimeout(() => stop(), 10_000);
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const type of INPUT) window.removeEventListener(type, stop);
    if (restoring === self) restoring = null;
  };
  const attempt = () => {
    if (restoring !== self) return;
    window.scrollTo(0, y);
    placed = { y: window.scrollY, max: maxScroll() };
    if (Math.abs(window.scrollY - y) < 1) stop();
  };
  // Back up the page, though it can still reach as far: the person, without a touch or key (the status
  // bar, the scrollbar, find in page). A page that got shorter, or a taller toolbar, pulls it up too.
  const scrolled = () => {
    if (placed && window.scrollY < placed.y - 1 && maxScroll() >= placed.max) stop();
  };
  const self = { y, stop, scrolled };
  restoring = self;
  for (const type of INPUT) window.addEventListener(type, stop, { passive: true });
  observer.observe(document.body);
  requestAnimationFrame(attempt);
}

const here = () => ({ key: key(), depth: depth(), path: location.pathname + location.search, hash: location.hash });
/** The entry on screen. By popstate, `history.state` is already the next one. */
let shown = here();

/** Mid-restore, where it is heading, not part way there. */
function record(entry = key()): void {
  // Newest last, so the oldest are the ones dropped.
  positions.delete(entry);
  positions.set(entry, restoring?.y ?? window.scrollY);
  if (positions.size > KEPT) positions.delete(positions.keys().next().value!);
}
window.addEventListener(
  "scroll",
  () => {
    restoring?.scrolled();
    record();
  },
  { passive: true },
);
window.addEventListener("popstate", () => {
  // No state: a link to a heading (the guide's contents) the browser has just followed, and may already
  // have scrolled to. It is the browser's to scroll.
  const followed = typeof current()?.depth !== "number";
  if (followed) {
    restoring?.stop();
    // A link to the heading already in the address replaces its entry rather than adding one.
    const again = shown.path === location.pathname + location.search && shown.hash === location.hash;
    const entry = again ? { depth: shown.depth, key: shown.key } : { depth: shown.depth + 1 };
    history.replaceState({ ...current(), ...entry }, "");
  } else {
    record(shown.key);
    save();
  }
  shown = here();
  if (followed) return;
  const y = positions.get(key());
  // A heading with no place kept is left where the browser put it.
  if (y !== undefined || !location.hash) restore(y ?? 0);
});
const hidden = () => {
  record();
  save();
};
// A phone may close a backgrounded app without a pagehide.
window.addEventListener("pagehide", hidden);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") hidden();
});
const reloaded = positions.get(key());
if (reloaded) restore(reloaded);

/** For tests, which share one tab: start with only what a reload would know. */
export function resetRouter(): void {
  restoring?.stop();
  load();
  shown = here();
}

/** A screen's own state, kept with its history entry so back, forward and a reload bring it back. */
export const entryState = (name: string): unknown => current()?.screen?.[name];

export function setEntryState(name: string, value: unknown): void {
  const state = current();
  history.replaceState({ ...state, depth: depth(), screen: { ...state?.screen, [name]: value } }, "");
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
