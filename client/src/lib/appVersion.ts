/**
 * The iPhone app's version and build (NFR-DEP-15), read from the binary by the app's native side
 * (ios/App/App/MainViewController.swift). Read once at start; the web build has none.
 */
import { useSyncExternalStore } from "react";
import { NATIVE } from "./server";

export interface AppVersion {
  version: string;
  build: string;
}

let current: AppVersion | null = null;
const listeners = new Set<() => void>();

/** Read the version from the app and keep it. Does nothing outside the app. */
export async function startAppVersion(bridge = window.Capacitor, native = NATIVE): Promise<void> {
  current = null;
  if (!native || !bridge) return;
  try {
    const { version, build } = (await bridge.nativePromise("VersionPlugin", "get", {})) as Partial<AppVersion>;
    if (typeof version === "string" && typeof build === "string") current = { version, build };
  } catch {
    // A build without the plugin has no version to show.
  }
  listeners.forEach((l) => l());
}

/** The app's version, or null on the web or before it is read. */
export const appVersion = (): AppVersion | null => current;

export function useAppVersion(): AppVersion | null {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, appVersion);
}

/** Sent on every request, so the server knows which builds still sync (NFR-DEP-16). Matches clients.py. */
export const CLIENT_HEADER = "X-Gear-Client";

/** "web <commit>", or "ios <version> (<build>) <commit>" in the app. */
export function clientVersion(native = NATIVE, app = appVersion()): string {
  if (!native) return `web ${__GIT_SHA__}`;
  return app ? `ios ${app.version} (${app.build}) ${__GIT_SHA__}` : `ios ${__GIT_SHA__}`;
}
