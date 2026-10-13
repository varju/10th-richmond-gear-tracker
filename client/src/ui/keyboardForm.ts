import { type RefObject, useEffect, useRef } from "react";

const FIELDS = "input, select, textarea";
/** A tap on one of these is meant for it, not for the background. */
const TAPPABLE = "input, select, textarea, button, a, label, [contenteditable]";

function focusedField(form: HTMLFormElement): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && form.contains(el) && el.matches(FIELDS) ? el : null;
}

/**
 * Scroll so the submit button sits above the on-screen keyboard. iOS pans rather than resizes
 * for the keyboard, so the visual viewport is what shows. The focused field stays on screen.
 */
export function revealSubmit(form: HTMLFormElement) {
  const vv = window.visualViewport;
  const field = focusedField(form);
  const button = form.querySelector<HTMLElement>('button[type="submit"]');
  if (!vv || !field || !button) return;
  const below = button.getBoundingClientRect().bottom - (vv.offsetTop + vv.height);
  const room = field.getBoundingClientRect().top - vv.offsetTop;
  const by = Math.min(below, room);
  if (by > 0) window.scrollBy(0, by);
}

/**
 * Keyboard manners for a short form on a phone: the submit button kept above the keyboard,
 * Return on an `enterKeyHint="next"` field moving to the next field, and a tap on the empty
 * background closing the keyboard.
 */
export function useKeyboardForm(): RefObject<HTMLFormElement | null> {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const form = ref.current;
    if (!form) return;
    const vv = window.visualViewport;
    const reveal = () => revealSubmit(form);
    // After the browser's own scroll to the focused field.
    const onFocus = () => requestAnimationFrame(reveal);

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== "Enter" || e.isComposing || el.getAttribute("enterkeyhint") !== "next") return;
      const fields = [...form.querySelectorAll<HTMLElement>(FIELDS)].filter((f) => !f.matches(":disabled"));
      const next = fields[fields.indexOf(el) + 1];
      if (!next) return;
      e.preventDefault();
      next.focus();
    };

    const onClick = (e: MouseEvent) => {
      const field = focusedField(form);
      if (!field || (e.target as Element).closest(TAPPABLE)) return;
      if (!(window.getSelection()?.isCollapsed ?? true)) return;
      field.blur();
    };

    form.addEventListener("focusin", onFocus);
    form.addEventListener("keydown", onKey);
    form.addEventListener("click", onClick);
    vv?.addEventListener("resize", reveal);
    return () => {
      form.removeEventListener("focusin", onFocus);
      form.removeEventListener("keydown", onKey);
      form.removeEventListener("click", onClick);
      vv?.removeEventListener("resize", reveal);
    };
  }, []);
  return ref;
}
