import { type ReactNode, useEffect, useRef, useState } from "react";

/** How long the "Really …?" state waits for the second tap. */
export const ASK_MS = 5000;

/**
 * For what the app cannot undo (NFR-USE-07, NFR-USE-12). The first tap turns the button into a
 * warning; a second tap does it. It turns back after `ASK_MS`, on a tap elsewhere, or when
 * `resetKey` changes. A failure shows beside the button.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = "",
  ariaLabel,
  confirmAriaLabel,
  disabled,
  resetKey,
}: {
  label: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => unknown;
  className?: string;
  ariaLabel?: string;
  confirmAriaLabel?: string;
  disabled?: boolean;
  resetKey?: unknown;
}) {
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function reset() {
    window.clearTimeout(timer.current);
    setAsked(false);
  }

  useEffect(reset, [resetKey]);

  // Blur does not fire for a button on iOS, and iOS sends a tap on plain content only to an
  // ancestor below body that has a click listener (see keyboardForm.ts).
  useEffect(() => {
    if (!asked) return;
    const area: HTMLElement | Document = button.current?.closest("main") ?? document;
    const away = (e: Event) => {
      if (!button.current?.contains(e.target as Node)) reset();
    };
    area.addEventListener("pointerdown", away);
    area.addEventListener("click", away);
    return () => {
      area.removeEventListener("pointerdown", away);
      area.removeEventListener("click", away);
    };
  }, [asked]);

  async function tap() {
    setError(null);
    if (!asked) {
      setAsked(true);
      timer.current = window.setTimeout(() => setAsked(false), ASK_MS);
      return;
    }
    reset();
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not do that");
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className={asked ? "warn" : className}
        aria-label={asked ? confirmAriaLabel : ariaLabel}
        disabled={disabled}
        onClick={() => void tap()}
        onBlur={reset}
      >
        {asked ? confirmLabel : label}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
