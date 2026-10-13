import { type RefObject, useEffect, useRef } from "react";
import { rectOf } from "../lib/viewport";

const FIELDS = "input, select, textarea";
/** Fields Return can move to. Ones that will not take focus are skipped when focus fails to move. */
const STOPS = 'input:not([type="hidden"]), select, textarea';
const SKIP = ':disabled, [readonly], [tabindex="-1"]';
/** A tap on one of these is meant for it, not for the background. */
const TAPPABLE = "input, select, textarea, button, a, label, [contenteditable]";
/** What Safari sends for the Return that confirms IME input, with `isComposing` already false. */
const IME_KEY = 229;

function focusedField(form: HTMLFormElement): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && form.contains(el) && el.matches(FIELDS) ? el : null;
}

/**
 * Scroll so the submit button sits above the on-screen keyboard. iOS pans rather than resizes
 * for the keyboard, so the visual viewport is what shows. The focused field stays on screen.
 * Not while zoomed: a pinch also resizes the visual viewport.
 */
export function revealSubmit(form: HTMLFormElement) {
  const vv = window.visualViewport;
  const field = rectOf(focusedField(form));
  const button = rectOf(form.querySelector('button[type="submit"]'));
  if (!vv || vv.scale !== 1 || !field || !button) return;
  const by = Math.min(button.y + button.h - vv.height, field.y);
  if (by > 0) window.scrollBy(0, by);
}

/** Focus the first of `fields` that takes it. False if none did. */
function focusFirst(fields: HTMLElement[]): boolean {
  for (const f of fields) {
    f.focus();
    if (document.activeElement === f) return true;
  }
  return false;
}

/**
 * Keyboard manners for a short form on a phone: the submit button kept above the keyboard,
 * Return on an `enterKeyHint="next"` field moving to the next field, Return with the submit
 * button disabled moving to the first empty required field, and a tap on the empty background
 * closing the keyboard.
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
      if (e.key !== "Enter" || e.isComposing || e.keyCode === IME_KEY) return;
      // Return on a button or link is for it, and Return in a textarea is a new line.
      if (!el.matches(FIELDS) || el instanceof HTMLTextAreaElement) return;
      const all = [...form.querySelectorAll<HTMLElement>(STOPS)];
      const stops = (from: number) => all.slice(from).filter((f) => !f.matches(SKIP));
      let moved = false;
      if (el.getAttribute("enterkeyhint") === "next") {
        moved = focusFirst(stops(all.indexOf(el) + 1));
      } else if (form.querySelector('button[type="submit"]:disabled')) {
        // Return would submit, but the button says the form is not ready.
        const empty = stops(0).filter((f) => f.matches("[required]") && !(f as HTMLInputElement).value.trim());
        moved = focusFirst(empty);
      }
      if (moved) e.preventDefault();
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
    // React's autoFocus ran before this effect, so its focusin went unheard.
    if (focusedField(form)) onFocus();
    return () => {
      form.removeEventListener("focusin", onFocus);
      form.removeEventListener("keydown", onKey);
      form.removeEventListener("click", onClick);
      vv?.removeEventListener("resize", reveal);
    };
  }, []);
  return ref;
}
