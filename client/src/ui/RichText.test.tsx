import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { RichText } from "./RichText";

const view = (text: string) => {
  const { container } = render(<RichText text={text} />);
  return {
    html: container.innerHTML,
    shown: container.textContent,
    hrefs: [...container.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    container,
  };
};

const linkCases: Array<[string, string, string[]]> = [
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
  ["javascript", "javascript:alert(1)", []],
  ["ftp", "ftp://a.b", []],
  ["nothing after the scheme", "https://.", []],
  ["angle brackets", "<https://a.b>", ["https://a.b"]],
  ["www", "www.a.b", ["http://www.a.b"]],
  ["an email address", "me@a.com", []],
  ["a link", "see [the manual](https://a.b/c).", ["https://a.b/c"]],
  ["a list item", "1. see https://a.b", ["https://a.b"]],
  ["a heading", "# https://a.b", ["https://a.b"]],
  ["a bullet", "- see https://a.b", ["https://a.b"]],
  ["javascript link", "[x](javascript:alert(1))", []],
  ["ftp link", "[x](ftp://a.b)", []],
  ["mailto link", "[x](mailto:a@b.c)", []],
  ["relative link", "[x](/a/b)", []],
  ["an image", "![i](https://a.b/c.png)", []],
  ["many closers", `see https://a.b/c${")".repeat(3000)}`, ["https://a.b/c"]],
];

test.each(linkCases)("links: %s", (_name, input, expected) => {
  const { hrefs } = view(input);
  expect(hrefs).toEqual(expected);
});

const typedCases: Array<[string, string]> = [
  ["plain text", "green tent"],
  ["a quote", "> quote"],
  ["code", "`code`"],
  ["strikethrough", "~~x~~"],
  ["a rule", "---"],
  ["a table", "| a | b |\n| - | - |\n| 1 | 2 |"],
  ["a task", "- [ ] task"],
  ["an image", "![i](https://a.b/c.png)"],
  ["a heading", "# title"],
  ["an ordered list", "1. one\n2. two"],
  ["an entity", "&amp; <b>x</b>"],
  ["script", "<script>alert(1)</script>"],
  ["javascript link", "[x](javascript:alert(1))"],
  ["ftp link", "[x](ftp://a.b)"],
  ["a mail address", "me@a.com"],
  ["asterisks around spaces", "2 * 3 * 4"],
  ["a plain star", "*a"],
  ["a blank line", "one\n\ntwo"],
];

test.each(typedCases)("shows as typed: %s", (_name, input) => {
  const { shown, container } = view(input);
  expect(shown).toBe(input);
  expect(container.querySelector("img, script, b, h1, blockquote, code, table, hr, del, ol, input")).toBeNull();
});

const htmlCases: Array<[string, string, string]> = [
  ["bold", "a **b** c", "a <strong>b</strong> c"],
  ["italic", "a *b* c", "a <em>b</em> c"],
  ["underscore emphasis", "_a_ and snake_case", "<em>a</em> and snake_case"],
  ["bold in italic", "*a **b** c*", "<em>a <strong>b</strong> c</em>"],
  ["escaped stars", "\\*x\\*", "*x*"],
  ["a line break", "a\nb", "a\nb"],
  ["a list", "- a\n- **b**", "<ul><li>a</li><li><strong>b</strong></li></ul>"],
  ["a nested list", "- a\n  - b", "<ul><li>a<ul><li>b</li></ul></li></ul>"],
  ["a loose list", "- a\n\n- b", "<ul><li>a</li><li>b</li></ul>"],
  ["text after a list", "one\ntwo\n- a\n- b\nthree", "one\ntwo<ul><li>a</li><li>b\nthree</li></ul>"],
  [
    "a link",
    "[the manual](https://a.b/c)",
    '<a href="https://a.b/c" target="_blank" rel="noopener noreferrer">the manual</a>',
  ],
  [
    "emphasis in link text",
    "[*a*](https://a.b)",
    '<a href="https://a.b" target="_blank" rel="noopener noreferrer"><em>a</em></a>',
  ],
  [
    "a list item that is not a bullet",
    "1. see https://a.b",
    '1. see <a href="https://a.b" target="_blank" rel="noopener noreferrer">https://a.b</a>',
  ],
];

test.each(htmlCases)("renders: %s", (_name, input, expected) => {
  expect(view(input).html).toBe(expected);
});

test("a link opens in a new tab", () => {
  render(<RichText text="[m](https://a.b/c)" />);
  const a = screen.getByRole("link", { name: "m" });
  expect(a).toHaveAttribute("href", "https://a.b/c");
  expect(a).toHaveAttribute("target", "_blank");
  expect(a).toHaveAttribute("rel", "noopener noreferrer");
});

test("RichText renders emphasis, links and lists, and no raw HTML", () => {
  const { container, shown } = view("**bold** and *it* [m](https://a.b/c) <b>x</b>\n- one\n- two https://d.e");
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelector("em")?.textContent).toBe("it");
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(container.querySelector("b")).toBeNull();
  expect(shown).toBe("bold and it m <b>x</b>onetwo https://d.e");
});

test("<script> shows as text", () => {
  const { container } = render(<RichText text="<script>alert(1)</script>" />);
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toBe("<script>alert(1)</script>");
});

test("text over the limit shows as typed, and the limit itself still parses", () => {
  const over = `**a** ${"x".repeat(4995)}`;
  expect(over).toHaveLength(5001);
  const long = view(over);
  expect(long.shown).toBe(over);
  expect(long.container.querySelector("strong")).toBeNull();

  const at = `**a** ${"x".repeat(4994)}`;
  expect(at).toHaveLength(5000);
  expect(view(at).container.querySelector("strong")?.textContent).toBe("a");
});

test.each([
  ["quotes", "> ".repeat(2500)],
  ["stars", "*a ".repeat(1600)],
  ["brackets", "[".repeat(5000)],
])("hostile input renders as typed: %s", (_name, input) => {
  expect(view(input).shown).toBe(input);
});

const wordCases: Array<[string, string]> = [
  ["a line break before a list marker", "Contents:\n1. tent\n2. poles"],
  ["a line break before a heading", "Tent\n# 3 in locker"],
  ["a line break before a quote", "one\n> quote"],
  ["empty link text", "[](https://a.b)"],
  ["blank link text", "[ ](https://a.b)"],
  ["a bare dash", "-"],
  ["a bare star", "*"],
  ["a bare plus", "+"],
  ["a Windows path", "C:\\Users"],
];

test.each(wordCases)("as typed, nothing lost: %s", (_name, input) => {
  const { shown, container } = view(input);
  expect(shown).toBe(input);
  expect(container.querySelector("a, em, strong, li")).toBeNull();
});

test.each([
  ["square brackets kept", "https://a.b/x[1]", ["https://a.b/x[1]"]],
  ["braces kept", "https://a.b/{id}", ["https://a.b/{id}"]],
])("bare URL edges: %s", (_name, input, expected) => {
  expect(view(input).hrefs).toEqual(expected);
});

test("an escape loses its backslash", () => {
  expect(view("\\*x\\* \\_y\\_ \\-a").shown).toBe("*x* _y_ -a");
});

test("the line break beside a list is dropped", () => {
  expect(view("one\n- a").html).toBe("one<ul><li>a</li></ul>");
});

test("a list nested 3 deep still renders as lists", () => {
  const { container } = view("- a\n  - b\n    - c");
  expect(container.querySelectorAll("ul")).toHaveLength(3);
});

test.each([
  ["a deep list", `${"- ".repeat(1000)}a`],
  ["deep emphasis", `${"*a **b ".repeat(500)}${"** a*".repeat(500)}`],
])("%s falls back to the typed text without throwing", (_name, input) => {
  const { shown, container } = view(input);
  expect(shown).toBe(input);
  expect(container.querySelector("ul, em, strong")).toBeNull();
});

test("a dash and space is not a bullet", () => {
  const { shown, container } = view("- ");
  expect(shown.trim()).toBe("-");
  expect(container.querySelector("li")).toBeNull();
});

const urls = Array.from({ length: 20 }, (_, n) => `https://a.b/${n}`);
const manyCases: Array<[string, string]> = [
  ["a space", urls.join(" ")],
  ["newlines", urls.join("\n")],
  ["brackets and a full stop", urls.map((u) => `(${u}).`).join(" ")],
  ["bullets", urls.map((u) => `- ${u}`).join("\n")],
];

test.each(manyCases)("20 URLs joined by %s are all links", (_name, input) => {
  expect(view(input).hrefs).toHaveLength(20);
});

test("emphasis after many URLs still renders", () => {
  expect(view(`${urls.join(" ")} **bold**`).container.querySelector("strong")?.textContent).toBe("bold");
});

test("many URLs log no React warnings", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const [, input] of manyCases) view(input);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
