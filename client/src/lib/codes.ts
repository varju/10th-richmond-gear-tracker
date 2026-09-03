/**
 * What a scan or a typed string means. A sticker's QR holds `<code_url>/g/<CODE>`;
 * a person may type just the code. Both end in the same 10 characters.
 */
import { CODE_PATTERN } from "./inventory";

/** The code in a bare code or any URL whose last path segment is one. Null when neither. */
export function parseCode(text: string): string | null {
  const path = text.trim().replace(/[?#].*$/, "");
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const code = last.toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** The URL a sticker for this code carries. Null until the group has set its site address. */
export function codeUrl(base: string | undefined, code: string): string | null {
  const trimmed = base?.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}/g/${code}` : null;
}
