import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { type Node, parseRich, RichText } from "./RichText";

const inlineOf = (s: string): Node[] => {
  const [b] = parseRich(s);
  return b && "p" in b ? b.p : [];
};
const t = (text: string): Node => ({ t: "text", text });
const link = (href: string, text = href): Node => ({ t: "link", text, href });
const b = (...kids: Node[]): Node => ({ t: "b", kids });
const i = (...kids: Node[]): Node => ({ t: "i", kids });

const flat = (ns: Node[]): Node[] => ns.flatMap((n) => (n.t === "b" || n.t === "i" ? flat(n.kids) : [n]));
const links = (s: string) => flat(inlineOf(s)).flatMap((n) => (n.t === "link" ? [n.href] : []));
const shown = (s: string) =>
  flat(inlineOf(s))
    .map((n) => (n.t === "text" || n.t === "link" ? n.text : ""))
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

test.each(cases)("links: %s", (_name, input, expected) => {
  expect(links(input)).toEqual(expected);
  if (!input.includes("*")) expect(shown(input)).toBe(input);
});

const inlineCases: Array<[string, string, Node[]]> = [
  ["bold", "a **b** c", [t("a "), b(t("b")), t(" c")]],
  ["italic", "a *b* c", [t("a "), i(t("b")), t(" c")]],
  ["bold with a link", "**see https://a.b/c**", [b(t("see "), link("https://a.b/c"))]],
  ["bold that is a URL", "**https://a.b/c**", [b(link("https://a.b/c"))]],
  ["italic with a URL", "*see https://a.b/c now*", [i(t("see "), link("https://a.b/c"), t(" now"))]],
  ["italic in bold", "**a *b* c**", [b(t("a "), i(t("b")), t(" c"))]],
  ["bold in italic", "*a **b** c*", [i(t("a "), b(t("b")), t(" c"))]],
  ["a link", "see [the manual](https://a.b/c).", [t("see "), link("https://a.b/c", "the manual"), t(".")]],
  [
    "brackets in the link URL",
    "[tent](https://en.wikipedia.org/wiki/Tent_(camping))",
    [link("https://en.wikipedia.org/wiki/Tent_(camping)", "tent")],
  ],
  ["no emphasis in link text", "[*a*](https://a.b)", [link("https://a.b", "*a*")]],
  ["javascript link", "[x](javascript:alert(1))", [t("[x](javascript:alert(1))")]],
  ["ftp link", "[x](ftp://a.b)", [t("[x](ftp://a.b)")]],
  ["credentials link", "[x](https://a@b.c)", [t("[x](https://a@b.c)")]],
  ["space in the URL", "[x](https://a.b/c d)", [t("[x]("), link("https://a.b/c"), t(" d)")]],
  ["asterisks around spaces", "2 * 3 * 4", [t("2 * 3 * 4")]],
  ["asterisks mid-word", "5*6*7", [t("5*6*7")]],
  ["a*b*c", "a*b*c", [t("a*b*c")]],
  ["empty bold", "****", [t("****")]],
  ["unclosed bold", "**a", [t("**a")]],
  ["unclosed italic", "*a", [t("*a")]],
  ["closer after a space", "*a *", [t("*a *")]],
  ["a URL is not emphasis", "https://a.b/*x*", [link("https://a.b/*x"), t("*")]],
  ["trailing star", "see https://a.b/c*", [t("see "), link("https://a.b/c"), t("*")]],
  ["two trailing stars", "https://a.b/c**", [link("https://a.b/c"), t("**")]],
  ["closer before a letter", "2 *3*4", [t("2 *3*4")]],
  ["closer before a letter, at the start", "*a*b", [t("*a*b")]],
  ["globs", "*.jpg,*.png", [t("*.jpg,*.png")]],
  ["stars in parentheses", "(*) x (*)", [t("(*) x (*)")]],
  ["three stars", "***a***", [b(i(t("a")))]],
  ["bold ending in italic", "**a *b***", [b(t("a "), i(t("b")))]],
  ["four stars", "****a****", [t("****a****")]],
  ["empty link text", "[](https://a.b)", [t("[]("), link("https://a.b"), t(")")]],
  [
    "link text that is an address",
    "[https://trusted.example](https://evil.com)",
    [t("["), link("https://trusted.example"), t("]("), link("https://evil.com"), t(")")],
  ],
  ["underscores", "_a_ and snake_case", [t("_a_ and snake_case")]],
  ["HTML", "<b>x</b> <script>y</script>", [t("<b>x</b> <script>y</script>")]],
];

test.each(inlineCases)("inline: %s", (_name, input, expected) => {
  expect(inlineOf(input)).toEqual(expected);
});

test("a list of two lines", () => {
  expect(parseRich("- a\n* **b**")).toEqual([{ ul: [[t("a")], [b(t("b"))]] }]);
});

test("a list between two paragraphs drops the newlines beside it", () => {
  expect(parseRich("one\ntwo\n- a\n- b\nthree")).toEqual([
    { p: [t("one"), t("\n"), t("two")] },
    { ul: [[t("a")], [t("b")]] },
    { p: [t("three")] },
  ]);
});

test("a star marks a list only with a space after it", () => {
  expect(parseRich("*italic*")).toEqual([{ p: [i(t("italic"))] }]);
  expect(parseRich("* item")).toEqual([{ ul: [[t("item")]] }]);
});

test("a marker with no content is not a list", () => {
  expect(parseRich("- ")).toEqual([{ p: [t("- ")] }]);
  expect(parseRich("* ")).toEqual([{ p: [t("* ")] }]);
});

test("long lines parse without overflowing the stack", () => {
  expect(inlineOf("*a* ".repeat(70000)).filter((n) => n.t === "i")).toHaveLength(70000);
  expect(links("https://a.b ".repeat(70000))).toHaveLength(70000);
});

test("a leading space, or no space, is not a list", () => {
  expect(parseRich(" - a")).toEqual([{ p: [t(" - a")] }]);
  expect(parseRich("-a")).toEqual([{ p: [t("-a")] }]);
});

const big = 50000;
test.each([
  ["*", "*"],
  ["**", "**"],
  ["[", "["],
  ["[a](", "[a]("],
  ["*a ", "*a "],
  ["**a ", "**a "],
])("%s repeated %i times stays as typed", (_n, unit) => {
  expect(shown(unit.repeat(big))).toBe(unit.repeat(big));
});

test("closing brackets after a URL", () => {
  const s = `https://a.b/c${")".repeat(big)}`;
  expect(links(s)).toEqual(["https://a.b/c"]);
  expect(shown(s)).toBe(s);
});

test("many short spans", () => {
  const ns = inlineOf("*a* ".repeat(big));
  expect(ns.filter((n) => n.t === "i")).toHaveLength(big);
});

test("RichText renders emphasis, links and lists, and no raw HTML", () => {
  const { container } = render(
    <RichText text={"**bold** and *it* [m](https://a.b/c) <b>x</b>\n- one\n- two https://d.e"} />,
  );
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(container.querySelector("em")?.textContent).toBe("it");
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(container.querySelector("b")).toBeNull();
  const a = screen.getByRole("link", { name: "m" });
  expect(a).toHaveAttribute("href", "https://a.b/c");
  expect(a).toHaveAttribute("target", "_blank");
  expect(a).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByRole("link", { name: "https://d.e" })).toHaveAttribute("href", "https://d.e");
  expect(container.textContent).toBe("bold and it m <b>x</b>onetwo https://d.e");
});

test("<script> shows as text", () => {
  const { container } = render(<RichText text="<script>alert(1)</script>" />);
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toBe("<script>alert(1)</script>");
});
