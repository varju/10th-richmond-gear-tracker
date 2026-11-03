import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { LinkedText, splitLinks } from "./LinkedText";

const links = (s: string) =>
  splitLinks(s)
    .filter((p) => p.href)
    .map((p) => p.href);
const rejoined = (s: string) =>
  splitLinks(s)
    .map((p) => p.text)
    .join("");

const cases: Array<[string, string, string[]]> = [
  ["plain text", "green tent", []],
  ["a URL alone", "https://a.b/c", ["https://a.b/c"]],
  ["mid sentence", "see https://a.b/c for more", ["https://a.b/c"]],
  ["trailing full stop", "see https://a.b/c.", ["https://a.b/c"]],
  ["surrounding brackets", "(see https://a.b/c)", ["https://a.b/c"]],
  [
    "balanced brackets",
    "https://en.wikipedia.org/wiki/Tent_(camping)",
    ["https://en.wikipedia.org/wiki/Tent_(camping)"],
  ],
  ["two URLs", "http://a.b and https://c.d, ok", ["http://a.b", "https://c.d"]],
  ["upper case", "HTTPS://A.B/x", ["HTTPS://A.B/x"]],
  ["mid-word start", "xhttp://a.b", []],
  ["javascript", "javascript:alert(1)", []],
  ["ftp", "ftp://a.b", []],
  ["nothing after the scheme", "https://.", []],
  ["curly quotes", "“https://a.b/c”", ["https://a.b/c"]],
  ["ellipsis", "https://a.b/c…", ["https://a.b/c"]],
  ["em dash", "https://a.b/c—next", ["https://a.b/c"]],
  ["emphasis marks", "**https://a.b/c**", ["https://a.b/c"]],
  ["square brackets kept", "https://a.b/x[1]", ["https://a.b/x[1]"]],
  ["braces kept", "https://a.b/{id}", ["https://a.b/{id}"]],
  ["square brackets around", "[https://a.b/c]", ["https://a.b/c"]],
  ["credentials", "https://trusted.example@evil.com", []],
  ["many closers", `see https://a.b/c${")".repeat(50000)}`, ["https://a.b/c"]],
];

test.each(cases)("splitLinks: %s", (_name, input, expected) => {
  expect(links(input)).toEqual(expected);
  expect(rejoined(input)).toBe(input);
});

test("LinkedText renders a link that opens in a new tab, with the text around it", () => {
  const { container } = render(<LinkedText text="Manual: https://a.b/c. Thanks" />);
  const a = screen.getByRole("link", { name: "https://a.b/c" });
  expect(a).toHaveAttribute("href", "https://a.b/c");
  expect(a).toHaveAttribute("target", "_blank");
  expect(a).toHaveAttribute("rel", "noopener noreferrer");
  expect(container.textContent).toBe("Manual: https://a.b/c. Thanks");
});
