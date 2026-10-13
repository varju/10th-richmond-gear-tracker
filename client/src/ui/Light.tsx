import { type ReactNode, useCallback, useState } from "react";
import type { Scanner } from "../lib/scanner";

/** The torch, for an unlit locker: the scanner that has one (the iPhone app), and whether it is on. */
export interface Light {
  scanner: Scanner;
  on: boolean;
}

/**
 * The screen's torch state. It lives with the screen, not the button, which goes when the card opens or typing
 * starts while the torch stays as it was. A new scanner starts with it off: the torch goes off with its camera.
 */
export function useLight() {
  const [light, setLight] = useState<Light | null>(null);
  /** From `onReady`. The same scanner coming back after the app was left keeps its torch. */
  const ready = useCallback(
    (scanner: Scanner, torch: boolean) =>
      setLight((was) => (!torch ? null : was?.scanner === scanner ? was : { scanner, on: false })),
    [],
  );
  const gone = useCallback(() => setLight(null), []);
  const toggle = useCallback(() => {
    if (!light) return;
    light.scanner.torch?.(!light.on);
    setLight({ ...light, on: !light.on });
  }, [light]);
  return { light, ready, gone, toggle };
}

/** `children` with a Light button beside it, where there is a torch. */
export function WithLight({
  light,
  onToggle,
  children,
}: {
  light: Light | null;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (!light) return children;
  return (
    <div className="with-light">
      {children}
      <button type="button" aria-pressed={light.on} onClick={onToggle}>
        Light
      </button>
    </div>
  );
}
