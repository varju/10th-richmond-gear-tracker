import { Fragment, type ReactNode } from "react";

// Descriptions show a small Markdown subset: **bold**, *italic*, [text](url) links, "- " bullet lists, and bare http(s)
// URLs. Everything else shows as typed. Each scan jumps past what it finds and remembers a failed search, so the
// whole parse is linear.
const URL_RE = /https?:\/\/[^\s<>“”‘’…—]+/iy;
const LINK_RE = /\[([^[\]]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/y;
const WORD = /\w/;
const LN = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "*", "`"]);
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function trimUrl(raw: string): string {
  const open: Record<string, number> = { "(": 0, "[": 0, "{": 0 };
  const close: Record<string, number> = { ")": 0, "]": 0, "}": 0 };
  for (const ch of raw) {
    if (ch in open) open[ch] = (open[ch] ?? 0) + 1;
    else if (ch in close) close[ch] = (close[ch] ?? 0) + 1;
  }
  let end = raw.length;
  while (end > 0) {
    const last = raw.charAt(end - 1);
    if (TRAILING.has(last)) {
      end--;
      continue;
    }
    const opener = PAIRS[last];
    const closers = close[last] ?? 0;
    if (opener !== undefined && closers > (open[opener] ?? 0)) {
      close[last] = closers - 1;
      end--;
    } else {
      break;
    }
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

export type Node =
  | { t: "text"; text: string }
  | { t: "link"; text: string; href: string }
  | { t: "b"; kids: Node[] }
  | { t: "i"; kids: Node[] };
export type Block = { ul: Node[][] } | { p: Node[] };

const isUrl = (url: string) => /^https?:\/\//i.test(url) && isLink(url);

function inline(s: string, prev: string, bold = true, ital = true): Node[] {
  const out: Node[] = [];
  let from = 0;
  let boldFail = false;
  let italFail = false;
  const flush = (to: number) => {
    if (to > from) out.push({ t: "text", text: s.slice(from, to) });
  };
  const before = (i: number) => (i === 0 ? prev : s.charAt(i - 1));
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === "[") {
      LINK_RE.lastIndex = i;
      const m = LINK_RE.exec(s);
      if (m && isUrl(m[2] as string) && !(m[1] as string).includes("://")) {
        flush(i);
        out.push({ t: "link", text: m[1] as string, href: m[2] as string });
        i = from = i + m[0].length;
        continue;
      }
    } else if (c === "h" || c === "H") {
      URL_RE.lastIndex = i;
      const m = URL_RE.exec(s);
      if (m) {
        const cut = m[0].indexOf("](");
        const raw = cut < 0 ? m[0] : m[0].slice(0, cut);
        const url = trimUrl(raw);
        if (WORD.test(before(i)) || !isLink(url)) {
          i += raw.length;
        } else {
          flush(i);
          out.push({ t: "link", text: url, href: url });
          i = from = i + url.length;
        }
        continue;
      }
    } else if (c === "*") {
      const two = s.charAt(i + 1) === "*";
      const n = i + (two ? 2 : 1);
      const next = s.charAt(n);
      const third = two && next === "*" && s.charAt(n + 1) !== "*" && /[\p{L}\p{N}[]/u.test(s.charAt(n + 1));
      if (
        (two ? bold && !boldFail : ital && !italFail) &&
        (third || (next !== "*" && /[\p{L}\p{N}[]/u.test(next))) &&
        !WORD.test(before(i))
      ) {
        let p = n + 1;
        let close = -1;
        for (;;) {
          let k = s.indexOf(two ? "**" : "*", p);
          if (k < 0) break;
          if (!two && s.charAt(k + 1) === "*") {
            p = k + 2;
            continue;
          }
          if (two && s.charAt(k + 2) === "*") {
            if (s.charAt(k + 3) === "*") {
              p = k + 4;
              continue;
            }
            k++;
          }
          if (SPACE.test(s.charAt(k - 1)) || LN.test(s.charAt(k + (two ? 2 : 1)))) p = k + 1;
          else {
            close = k;
            break;
          }
        }
        if (close >= 0) {
          flush(i);
          const t = two ? "b" : "i";
          out.push({ t, kids: inline(s.slice(n, close), "*", t === "i" && bold, t === "b" && ital) });
          i = from = close + (n - i);
          continue;
        }
        if (two) boldFail = true;
        else italFail = true;
      }
      i = n;
      continue;
    }
    i++;
  }
  flush(s.length);
  return out;
}

export function parseRich(text: string): Block[] {
  const blocks: Block[] = [];
  let para: Node[] | null = null;
  let list: Node[][] | null = null;
  for (const line of text.split("\n")) {
    if (/^[-*] .*\S/.test(line)) {
      para = null;
      if (!list) blocks.push({ ul: (list = []) });
      list.push(inline(line.slice(2), " "));
    } else {
      list = null;
      if (para) para.push({ t: "text", text: "\n" });
      else blocks.push({ p: (para = []) });
      for (const n of inline(line, " ")) para.push(n);
    }
  }
  return blocks;
}

function nodes(ns: Node[]): ReactNode {
  return ns.map((n, i) => {
    if (n.t === "text") return <Fragment key={i}>{n.text}</Fragment>;
    if (n.t === "b") return <strong key={i}>{nodes(n.kids)}</strong>;
    if (n.t === "i") return <em key={i}>{nodes(n.kids)}</em>;
    return (
      <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
        {n.text}
      </a>
    );
  });
}

export function RichText({ text }: { text: string }) {
  return (
    <>
      {parseRich(text).map((b, i) =>
        "ul" in b ? (
          <ul key={i}>
            {b.ul.map((li, j) => (
              <li key={j}>{nodes(li)}</li>
            ))}
          </ul>
        ) : (
          <Fragment key={i}>{nodes(b.p)}</Fragment>
        ),
      )}
    </>
  );
}
