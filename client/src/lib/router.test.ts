import { expect, test, vi } from "vitest";
import { back, depth, navigate, parseRoute } from "./router";

test("a route is its segments and query", () => {
  expect(parseRoute("/items/abc?code=X")).toMatchObject({ path: "/items/abc", segments: ["items", "abc"] });
  expect(parseRoute("/items/abc?code=X").query.get("code")).toBe("X");
  expect(parseRoute("/").segments).toEqual([]);
});

test("a base path is taken off the front", () => {
  expect(parseRoute("/gear/items/abc", "/gear").segments).toEqual(["items", "abc"]);
  expect(parseRoute("/gear/", "/gear").path).toBe("/");
  expect(parseRoute("/gear", "/gear").path).toBe("/");
  // A sticker's URL may sit outside the app's own path, so leave it alone.
  expect(parseRoute("/g/ABC123", "/gear").segments).toEqual(["g", "ABC123"]);
});

test("depth counts the steps taken inside the app", () => {
  expect(depth()).toBe(0);
  navigate("/items");
  expect(depth()).toBe(1);
  navigate("/items/abc");
  expect(depth()).toBe(2);
  // A replacement stands in for the entry it replaced, at the same depth.
  navigate("/items/abc?edit=1", true);
  expect(depth()).toBe(2);
  expect(location.pathname + location.search).toBe("/items/abc?edit=1");
});

test("back retraces the way in", () => {
  navigate("/items?q=tent");
  navigate("/items/abc");
  back("/");
  expect(location.pathname + location.search).toBe("/items?q=tent");
  expect(depth()).toBe(1);
  back("/");
  expect(location.pathname).toBe("/");
  expect(depth()).toBe(0);
});

test("back on a cold load goes to the fallback instead of out of the app", () => {
  // A sticker's URL, opened from a camera app: nothing of ours is behind it.
  history.replaceState({ depth: 0 }, "", "/g/ABC123");
  back("/");
  expect(location.pathname).toBe("/");
  expect(depth()).toBe(0);
});

/** Scrolls the window and waits for the app to hear it. */
async function scrollTo(y: number): Promise<void> {
  window.scrollTo(0, y);
  window.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(window.scrollY).toBe(y));
}

function popped(): Promise<unknown> {
  return new Promise((done) => window.addEventListener("popstate", done, { once: true }));
}

test("a new screen opens at the top", async () => {
  navigate("/items");
  await scrollTo(900);
  navigate("/items/abc");
  expect(window.scrollY).toBe(0);
});

test("a replace keeps its place on the same screen, and starts another at the top", async () => {
  navigate("/items");
  await scrollTo(900);
  navigate("/items?q=tent", true);
  expect(window.scrollY).toBe(900);
  navigate("/items/abc", true);
  expect(window.scrollY).toBe(0);
});

test("back and forward return each screen to where it was scrolled", async () => {
  navigate("/items");
  await scrollTo(900);
  navigate("/items/abc");
  await scrollTo(300);

  let pop = popped();
  back("/");
  await pop;
  await vi.waitFor(() => expect(window.scrollY).toBe(900));

  // Scrolled on, so the position kept is the latest, not the one at the first tap.
  await scrollTo(2000);
  pop = popped();
  history.forward();
  await pop;
  await vi.waitFor(() => expect(window.scrollY).toBe(300));

  pop = popped();
  history.back();
  await pop;
  await vi.waitFor(() => expect(window.scrollY).toBe(2000));
});

test("a link to a heading on the page is left where the browser put it", async () => {
  navigate("/help");
  await scrollTo(500);
  history.pushState(null, "", "/help#checking-out");
  window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  await new Promise(requestAnimationFrame);
  expect(window.scrollY).toBe(500);
});
