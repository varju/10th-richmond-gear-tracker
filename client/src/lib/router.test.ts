import { expect, test } from "vitest";
import { parseRoute } from "./router";

test("a route is its segments and query", () => {
  expect(parseRoute("/items/abc?code=X")).toMatchObject({ path: "/items/abc", segments: ["items", "abc"] });
  expect(parseRoute("/items/abc?code=X").query.get("code")).toBe("X");
  expect(parseRoute("/").segments).toEqual([]);
});
