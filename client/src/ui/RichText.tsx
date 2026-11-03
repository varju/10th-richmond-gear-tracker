import { Fragment, type ReactNode } from "react";
import { Lexer, Tokenizer, type Token, type Tokens } from "marked";

// Marked is quadratic or recursive on some inputs, so long text is not parsed.
const MAX_LENGTH = 5000;
// Deeper nesting overflows React's stack, so past this the text shows as typed.
const MAX_DEPTH = 16;
class NoDefs extends Tokenizer {
  override def(): undefined {
    return undefined;
  }
}
const OPTIONS = { gfm: true, breaks: true, tokenizer: new NoDefs() };
const ALNUM_END = /[\p{L}\p{N}]$/u;
const ALNUM_START = /^[\p{L}\p{N}]/u;

function isLink(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname !== "" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

const isUrl = (url: string) => /^https?:\/\//i.test(url) && isLink(url);

const kids = (t: Token): Token[] => (t as { tokens?: Token[] }).tokens ?? [];

function linkNode(t: Tokens.Link, key: number, depth: number): ReactNode {
  if (!t.text.trim()) return t.raw;
  if (!isUrl(t.href) || (t.text.includes("://") && t.text !== t.href)) return t.raw;
  return (
    <a key={key} href={t.href} target="_blank" rel="noopener noreferrer">
      {inline(kids(t), depth + 1)}
    </a>
  );
}

function emphasis(t: Token, i: number, tokens: Token[], depth: number): ReactNode {
  const n = t.type === "em" ? 1 : 2;
  const inner = inline(kids(t), depth + 1);
  const asText =
    t.raw.startsWith("*") &&
    ((i > 0 && ALNUM_END.test(tokens[i - 1]?.raw ?? "")) || ALNUM_START.test(tokens[i + 1]?.raw ?? ""));
  if (asText) {
    return (
      <Fragment key={i}>
        {t.raw.slice(0, n)}
        {inner}
        {t.raw.slice(-n)}
      </Fragment>
    );
  }
  return t.type === "em" ? <em key={i}>{inner}</em> : <strong key={i}>{inner}</strong>;
}

function inline(input: Token[], depth: number): ReactNode {
  if (depth > MAX_DEPTH) throw new Error("too deep");
  const out: ReactNode[] = [];
  for (let i = 0; i < input.length; i++) {
    const t = input[i] as Token;
    switch (t.type) {
      case "strong":
      case "em":
        out.push(emphasis(t, i, input, depth));
        break;
      case "escape":
        out.push(<Fragment key={i}>{t.text}</Fragment>);
        break;
      case "text":
        out.push(<Fragment key={i}>{kids(t).length ? inline(kids(t), depth) : t.raw}</Fragment>);
        break;
      case "link":
        out.push(linkNode(t as Tokens.Link, i, depth));
        break;
      default:
        out.push(<Fragment key={i}>{t.raw}</Fragment>);
    }
  }
  return out;
}

const typed = (raw: string) => inline(Lexer.lexInline(raw, OPTIONS), 0);

function simpleList(t: Token): boolean {
  const l = t as Tokens.List;
  if (l.type !== "list" || l.ordered) return false;
  return l.items.every(
    (item) =>
      item.text.trim() !== "" && item.tokens.every((k) => k.type === "text" || k.type === "paragraph" || simpleList(k)),
  );
}

function list(t: Tokens.List, depth: number): ReactNode {
  if (depth > MAX_DEPTH) throw new Error("too deep");
  return (
    <ul>
      {t.items.map((item, i) => (
        <li key={i}>
          {item.tokens.map((k, j) =>
            k.type === "list" ? (
              <Fragment key={j}>{list(k as Tokens.List, depth + 1)}</Fragment>
            ) : (
              <Fragment key={j}>{inline(kids(k), depth + 1)}</Fragment>
            ),
          )}
        </li>
      ))}
    </ul>
  );
}

function blocks(text: string): ReactNode {
  const all = Lexer.lex(text, OPTIONS);
  return all.map((t, i) => {
    if (t.type === "paragraph") {
      const next = all[i + 1];
      const nl = t.raw.endsWith("\n") && next && !simpleList(next) ? "\n" : "";
      return (
        <Fragment key={i}>
          {inline(kids(t), 0)}
          {nl}
        </Fragment>
      );
    }
    if (t.type === "space") return <Fragment key={i}>{t.raw}</Fragment>;
    if (simpleList(t)) return <Fragment key={i}>{list(t as Tokens.List, 0)}</Fragment>;
    return <Fragment key={i}>{typed(t.raw)}</Fragment>;
  });
}

export function RichText({ text }: { text: string }) {
  if (text.length > MAX_LENGTH) return <>{text}</>;
  try {
    return <>{blocks(text)}</>;
  } catch {
    return <>{text}</>;
  }
}
