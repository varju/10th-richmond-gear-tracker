import { Fragment, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";

// Marked is quadratic or recursive on some inputs, so long text is not parsed.
const MAX_LENGTH = 5000;
// Deeper nesting overflows React's stack, so past this the text shows as typed.
const MAX_DEPTH = 16;
const OPTIONS = { gfm: true, breaks: true };

const isUrl = (url: string) => /^https?:\/\//i.test(url);

const kids = (t: Token): Token[] => (t as { tokens?: Token[] }).tokens ?? [];

function linkNode(t: Tokens.Link, key: number, depth: number): ReactNode {
  if (!t.text.trim()) return t.raw;
  if (!isUrl(t.href)) return t.raw;
  return (
    <a key={key} href={t.href} target="_blank" rel="noopener noreferrer">
      {inline(kids(t), depth + 1)}
    </a>
  );
}

function inline(input: Token[], depth: number): ReactNode {
  if (depth > MAX_DEPTH) throw new Error("too deep");
  const out: ReactNode[] = [];
  for (let i = 0; i < input.length; i++) {
    const t = input[i] as Token;
    switch (t.type) {
      case "strong":
        out.push(<strong key={i}>{inline(kids(t), depth + 1)}</strong>);
        break;
      case "em":
        out.push(<em key={i}>{inline(kids(t), depth + 1)}</em>);
        break;
      case "escape":
        out.push(<Fragment key={i}>{t.text}</Fragment>);
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
    return <Fragment key={i}>{inline(Lexer.lexInline(t.raw, OPTIONS), 0)}</Fragment>;
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
