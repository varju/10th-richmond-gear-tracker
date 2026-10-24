import { expect, test } from "vitest";
import { isHttpsLink } from "./install";

// The same table is in tests/test_events.py: one rule, two languages.
const HTTPS_LINKS = [
  "https://apps.example.com/app/id1",
  "HTTPS://apps.example.com/x",
  "https://a.example.com?x=1",
  "https://a",
];
const NOT_HTTPS_LINKS = [
  "https:///apps.example.com/x",
  "https://a b.example.com",
  "https://a.example.com/x y",
  "https://a.example.com\n",
  "https:",
  "https:/",
  "https://",
  "https:apps.example.com/x",
  "https:/apps.example.com/x",
  "http://apps.example.com/x",
  " https://apps.example.com/x",
];

test.each(HTTPS_LINKS)("%s is an https link", (link) => expect(isHttpsLink(link)).toBe(true));
test.each(NOT_HTTPS_LINKS)("%j is not an https link", (link) => expect(isHttpsLink(link)).toBe(false));
