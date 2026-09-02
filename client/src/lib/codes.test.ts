import { expect, test } from "vitest";
import { codeUrl, parseCode } from "./codes";

test("a bare code is accepted in either case, with surrounding space", () => {
  expect(parseCode("ABCDEFGH23")).toBe("ABCDEFGH23");
  expect(parseCode("  abcdefgh23\n")).toBe("ABCDEFGH23");
});

test("a sticker URL yields its last path segment", () => {
  expect(parseCode("https://varju.ca/g/ABCDEFGH23")).toBe("ABCDEFGH23");
  expect(parseCode("varju.ca/g/abcdefgh23/")).toBe("ABCDEFGH23");
  expect(parseCode("https://varju.ca/g/ABCDEFGH23?utm=x#top")).toBe("ABCDEFGH23");
});

test("anything else is not a code", () => {
  expect(parseCode("")).toBeNull();
  expect(parseCode("ABCDEFGH2")).toBeNull();
  expect(parseCode("ABCDEFGH23X")).toBeNull();
  expect(parseCode("ABCDEFGHIL")).toBeNull(); // I and L are not Crockford
  expect(parseCode("https://varju.ca/g/")).toBeNull();
  expect(parseCode("https://example.org/tent")).toBeNull();
});

test("codeUrl joins the group's base with the code, or gives up without a base", () => {
  expect(codeUrl("https://varju.ca/g", "ABCDEFGH23")).toBe("https://varju.ca/g/ABCDEFGH23");
  expect(codeUrl("https://varju.ca/g/", "ABCDEFGH23")).toBe("https://varju.ca/g/ABCDEFGH23");
  expect(codeUrl(undefined, "ABCDEFGH23")).toBeNull();
  expect(codeUrl("  ", "ABCDEFGH23")).toBeNull();
});
