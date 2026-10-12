import { render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, test } from "vitest";
import { App } from "../App";
import { openStore, printCodes } from "../ui/codeTestKit";
import * as act from "./actions";
import { createApi } from "./api";
import { openDb } from "./db";
import { followLinks, linkRoute } from "./links";
import { Store } from "./store";

const SERVER = "https://example.org/gear";
const T0 = 1_756_684_800_000;

test("a link under the server's address becomes the route after it", () => {
  expect(linkRoute("https://example.org/gear/join?token=ABC", SERVER)).toBe("/join?token=ABC");
  expect(linkRoute("https://example.org/gear/join?link=XYZ", SERVER)).toBe("/join?link=XYZ");
  expect(linkRoute("https://example.org/gear", SERVER)).toBe("/");
  expect(linkRoute("https://example.org/gear/", SERVER)).toBe("/");
  expect(linkRoute("https://example.org/gear/join#top", `${SERVER}/`)).toBe("/join");
});

test("a sticker's link becomes the route a scan of it takes", () => {
  expect(linkRoute("https://example.org/gear/g/abcdefgh23", SERVER)).toBe("/g/ABCDEFGH23");
  expect(linkRoute("https://example.org/gear/g/ABCDEFGH23/?utm=x", SERVER)).toBe("/g/ABCDEFGH23");
});

test("a server at a domain root takes every path", () => {
  expect(linkRoute("http://127.0.0.1:8000/g/ABCDEFGH23", "http://127.0.0.1:8000")).toBe("/g/ABCDEFGH23");
});

test("a link anywhere else is not ours", () => {
  expect(linkRoute("https://example.org/gearbox/join", SERVER)).toBeNull();
  expect(linkRoute("https://example.org/join", SERVER)).toBeNull();
  expect(linkRoute("https://other.example/gear/join", SERVER)).toBeNull();
  expect(linkRoute("http://example.org/gear/join", SERVER)).toBeNull();
  expect(linkRoute("not a url", SERVER)).toBeNull();
});

/** The native side as the page sees it: it holds one link until the page takes it. */
function nativeSide() {
  let pending: string | undefined;
  return {
    bridge: {
      nativePromise: async (plugin: string, method: string) => {
        expect([plugin, method]).toEqual(["LinkPlugin", "take"]);
        const url = pending;
        pending = undefined;
        return url ? { url } : {};
      },
    },
    open(url: string) {
      pending = url;
      window.dispatchEvent(new Event("gear:link"));
    },
    hold(url: string) {
      pending = url;
    },
  };
}

let stop = () => undefined as void;
afterEach(() => stop());

// The server is out of reach: a link must still land, from what this device holds.
const offline = async (): Promise<Response> => {
  throw new TypeError("Failed to fetch");
};

test("a link that launched the app is taken once the page starts", async () => {
  const store = await Store.open(await openDb("links", new IDBFactory()));
  const native = nativeSide();
  native.hold(`${SERVER}/join?token=GOOD`);
  render(<App store={store} api={createApi({ fetch: offline, token: () => store.meta.token })} now={() => T0} />);
  stop = followLinks(native.bridge, SERVER, true);
  expect(await screen.findByLabelText("New password")).toBeInTheDocument();
  expect(location.pathname + location.search).toBe("/join?token=GOOD");
});

test("a sticker's link opens its item in the running app, offline", async () => {
  const store = await openStore();
  await printCodes(store, ["AAAAAAAAAA"]);
  const tent = await act.createItem(store, { name: "Tent" });
  await act.bindCode(store, "AAAAAAAAAA", tent);
  const native = nativeSide();
  render(<App store={store} api={createApi({ fetch: offline, token: () => store.meta.token })} now={() => T0} />);
  stop = followLinks(native.bridge, SERVER, true);
  native.open(`${SERVER}/g/aaaaaaaaaa`);
  await waitFor(() => expect(location.pathname).toBe(`/items/${tent}`));
});

test("a link that is not ours leaves the app where it was", async () => {
  const native = nativeSide();
  stop = followLinks(native.bridge, SERVER, true);
  native.open("https://example.org/elsewhere");
  await new Promise((r) => setTimeout(r, 0));
  expect(location.pathname).toBe("/");
});

test("the web build has no native side to ask", async () => {
  const native = nativeSide();
  native.hold(`${SERVER}/g/AAAAAAAAAA`);
  stop = followLinks(native.bridge, SERVER, false);
  native.open(`${SERVER}/g/BBBBBBBBBB`);
  await new Promise((r) => setTimeout(r, 0));
  expect(location.pathname).toBe("/");
});
