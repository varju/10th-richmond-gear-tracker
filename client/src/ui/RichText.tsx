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
const PUNCT_THEN_CURLY = /[.,;:!?'"]*[“”‘’…—]/;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "*"]);
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const ALNUM_END = /[\p{L}\p{N}]$/u;
const ALNUM_START = /^[\p{L}\p{N}]/u;
const OPENS_EMPHASIS = /^[\p{L}\p{N}[*]/u;

function trimUrl(raw: string): string {
  const count: Record<string, number> = {};
  for (const ch of raw) if (ch in PAIRS || Object.values(PAIRS).includes(ch)) count[ch] = (count[ch] ?? 0) + 1;
  let end = raw.length;
  while (end > 0) {
    const last = raw.charAt(end - 1);
    const opener = PAIRS[last];
    if (TRAILING.has(last)) end--;
    else if (opener !== undefined && (count[last] ?? 0) > (count[opener] ?? 0)) {
      count[last] = (count[last] ?? 0) - 1;
      end--;
    } else break;
  }
  return raw.slice(0, end);
}

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

function anchor(href: string, text: string, inner: ReactNode, key: number): ReactNode | null {
  if (!isUrl(href) || (text.includes("://") && text !== href)) return null;
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer">
      {inner}
    </a>
  );
}

function linkNode(t: Tokens.Link, key: number, depth: number): ReactNode {
  if (!t.text.trim()) return t.raw;
  return anchor(t.href, t.text, inline(kids(t), depth + 1), key) ?? t.raw;
}

// A bare URL runs on through curly quotes and closing punctuation. The part past the URL is lexed again, with
// everything after it, so later links and emphasis still work.
function bareLink(t: Tokens.Link, prev: Token | undefined, key: number): [ReactNode, string] | null {
  if (prev && /\w$/.test(prev.raw)) return null;
  const m = PUNCT_THEN_CURLY.exec(t.raw);
  const head = trimUrl(m ? t.raw.slice(0, m.index) : t.raw);
  const prefix = t.href.endsWith(t.raw) ? t.href.slice(0, t.href.length - t.raw.length) : "";
  const a = head ? anchor(prefix + head, head, head, key) : null;
  return a ? [a, t.raw.slice(head.length)] : null;
}

function emphasis(t: Token, key: number, i: number, tokens: Token[], depth: number): ReactNode {
  const n = t.type === "em" ? 1 : 2;
  const inner = inline(kids(t), depth + 1);
  const asText =
    t.raw.startsWith("*") &&
    ((i > 0 && ALNUM_END.test(tokens[i - 1]?.raw ?? "")) ||
      ALNUM_START.test(tokens[i + 1]?.raw ?? "") ||
      !OPENS_EMPHASIS.test(t.raw.slice(n)));
  if (asText) {
    return (
      <Fragment key={key}>
        {t.raw.slice(0, n)}
        {inner}
        {t.raw.slice(-n)}
      </Fragment>
    );
  }
  return t.type === "em" ? <em key={key}>{inner}</em> : <strong key={key}>{inner}</strong>;
}

function inline(input: Token[], depth: number): ReactNode {
  let tokens = input;
  if (depth > MAX_DEPTH) throw new Error("too deep");
  const out: ReactNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    switch (t.type) {
      case "strong":
      case "em":
        out.push(emphasis(t, out.length, i, tokens, depth));
        break;
      case "escape":
        out.push(<Fragment key={out.length}>{t.text === "*" || t.text === "_" ? t.text : t.raw}</Fragment>);
        break;
      case "text":
        out.push(<Fragment key={out.length}>{kids(t).length ? inline(kids(t), depth) : t.raw}</Fragment>);
        break;
      case "link": {
        const l = t as Tokens.Link;
        if (l.raw !== l.text) {
          out.push(linkNode(l, out.length, depth));
          break;
        }
        const bare = bareLink(l, tokens[i - 1], out.length);
        if (!bare) {
          out.push(l.raw);
          break;
        }
        out.push(bare[0]);
        if (bare[1]) {
          tokens = Lexer.lexInline(
            bare[1] +
              tokens
                .slice(i + 1)
                .map((k) => k.raw)
                .join(""),
            OPTIONS,
          );
          i = -1;
        }
        break;
      }
      default:
        out.push(<Fragment key={out.length}>{t.raw}</Fragment>);
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
