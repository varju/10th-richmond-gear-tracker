import { Fragment } from "react";

// Descriptions are plain text; only http(s) URLs become links.
const URL_RE = /https?:\/\/[^\s<>“”‘’…—]+/gi;
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

export function splitLinks(text: string): Array<{ text: string; href?: string }> {
  const parts: Array<{ text: string; href?: string }> = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index;
    if (start > 0 && /\w/.test(text.charAt(start - 1))) continue;
    const url = trimUrl(m[0]);
    if (!isLink(url)) continue;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: url, href: url });
    at = start + url.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((p, i) => (
        <Fragment key={i}>
          {p.href ? (
            <a href={p.href} target="_blank" rel="noopener noreferrer">
              {p.text}
            </a>
          ) : (
            p.text
          )}
        </Fragment>
      ))}
    </>
  );
}
