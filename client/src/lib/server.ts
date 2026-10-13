/**
 * Where the server is. The web build is served by the server, so it is this page's own
 * origin and path. The iPhone app (NFR-DEP-11) serves the client from disk, so its build
 * says where the server is, and that build is the only one with `NATIVE` set.
 */
import { BASE } from "./router";

export const NATIVE = __SERVER_URL__ !== "";

/** What API paths are joined to. A path in the web build, a full URL in the app. */
export const API_BASE = NATIVE ? __SERVER_URL__ : BASE;

/** The address a person opens in a browser, for links we show, print or mail. No trailing slash. */
export const siteUrl = (): string => (NATIVE ? __SERVER_URL__ : `${location.origin}${BASE}`);

/** The privacy policy (FR-PUB-07). A page the server writes, so the app opens it in the browser. */
export const privacyUrl = (): string => `${siteUrl()}/privacy`;
