import { expect, test } from "vitest";
import { filterParams, readFilter } from "./listUrl";

test("needs round-trips through the query string, and an unknown value is ignored", () => {
  for (const needs of ["code", "location", "shelf"] as const) {
    const params = filterParams("", { needs });
    expect(params.toString()).toBe(`needs=${needs}`);
    expect(readFilter(params).needs).toBe(needs);
  }
  expect(readFilter(new URLSearchParams("needs=bogus")).needs).toBeUndefined();
  expect(filterParams("", {}).toString()).toBe("");
});
