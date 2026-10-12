/**
 * Links that open the iPhone app (NFR-DEP-11). The site lets the app claim its join links and
 * sticker URLs (docs/deploy.md), so iOS opens them in the app, not Safari. The app's native side
 * holds the link until the page asks for it (ios/App/App/MainViewController.swift): once at
 * start, since a link can launch the app before the page has loaded, and again on each
 * `gear:link` event it sends.
 */
import { parseCode } from "./codes";
import { NATIVE } from "./server";
import { leave } from "./unsaved";

/** The in-app route for a link, or null when the link is not under the server's address. */
export function linkRoute(href: string, server = __SERVER_URL__): string | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(href);
    base = new URL(server);
  } catch {
    return null;
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  if (url.origin !== base.origin) return null;
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  const path = url.pathname.slice(prefix.length) || "/";
  // A sticker's URL lands where scanning the sticker does.
  const [head, code, ...rest] = path.split("/").filter(Boolean);
  if (head === "g" && code && rest.length === 0) return `/g/${parseCode(code) ?? code}`;
  return path + url.search;
}

/** Go to each link the app is opened with. Does nothing outside the app. Returns how to stop. */
export function followLinks(bridge = window.Capacitor, server = __SERVER_URL__, native = NATIVE): () => void {
  if (!native || !bridge) return () => undefined;
  const take = async () => {
    const { url } = (await bridge.nativePromise("LinkPlugin", "take", {})) as { url?: string };
    const route = url ? linkRoute(url, server) : null;
    if (route) leave(route);
  };
  // A build without the plugin has no links to give; the app opens where it would anyway.
  const follow = () => void take().catch(() => undefined);
  window.addEventListener("gear:link", follow);
  follow();
  return () => window.removeEventListener("gear:link", follow);
}
