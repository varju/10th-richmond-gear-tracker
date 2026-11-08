/** A newer web build waiting to be installed. Nothing reloads until the person asks. */
import { useSyncExternalStore } from "react";
import type { registerSW } from "virtual:pwa-register";

const HOUR_MS = 60 * 60 * 1000;
const VISIBLE_CHECK_MS = 5 * 60 * 1000;

class Update {
  ready = false;
  private install: (() => unknown) | null = null;
  private asked = false;
  private listeners = new Set<() => void>();

  get hasAsked(): boolean {
    return this.asked;
  }

  markReady(install: () => unknown): void {
    this.install = install;
    if (!this.ready) {
      this.ready = true;
      for (const l of this.listeners) l();
    }
  }

  apply = (): void => {
    this.asked = true;
    void this.install?.();
  };

  reset(): void {
    this.ready = false;
    this.install = null;
    this.asked = false;
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const update = new Update();

interface Options {
  everyMs?: number;
  reload?: () => void;
}

/** Returns a function that stops the checks. */
export function watchForUpdates(register: typeof registerSW, opts: Options = {}): () => void {
  const everyMs = opts.everyMs ?? HOUR_MS;
  const reload = opts.reload ?? (() => window.location.reload());
  let stop = () => {};
  const updateSW = register({
    immediate: true,
    onNeedRefresh: () => update.markReady(() => updateSW(true)),
    // Another tab's Reload installs the worker under this tab too; reload it only if it asked.
    onNeedReload: () => (update.hasAsked ? reload() : update.markReady(reload)),
    onRegisteredSW: (_url, reg) => {
      if (!reg) return;
      let lastVisible = 0;
      const check = () => void reg.update().catch(() => {});
      const timer = setInterval(() => {
        if (document.visibilityState !== "hidden") check();
      }, everyMs);
      const onVisible = () => {
        if (document.visibilityState !== "visible" || Date.now() - lastVisible < VISIBLE_CHECK_MS) return;
        lastVisible = Date.now();
        check();
      };
      document.addEventListener("visibilitychange", onVisible);
      stop = () => {
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
      };
    },
  });
  return () => stop();
}

export function useUpdateReady(): boolean {
  return useSyncExternalStore(update.subscribe, () => update.ready);
}
