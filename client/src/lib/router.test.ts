import { expect, test } from "vitest";
import { parseRoute } from "./router";

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
