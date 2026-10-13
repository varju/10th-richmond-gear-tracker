export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where `el` sits on screen: in the window, less how far the visual viewport is panned, as by the keyboard. */
export function rectOf(el: Element | null | undefined): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const pan = window.visualViewport;
  return { x: r.left - (pan?.offsetLeft ?? 0), y: r.top - (pan?.offsetTop ?? 0), w: r.width, h: r.height };
}
