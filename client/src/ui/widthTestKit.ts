/**
 * Window width for the tests. The layout turns at 900 px (lib/wide.ts), and
 * the test DOM starts at 1024, so every test would be at a desk unless one is
 * asked for. test-setup.ts puts each test at a phone; call desk() to widen.
 */
export const PHONE = 390;
export const DESK = 1280;

interface Viewport {
  happyDOM: { setViewport: (size: { width: number }) => void };
}

export function setWidth(width: number): void {
  (window as unknown as Viewport).happyDOM.setViewport({ width });
}

/** A desk browser, with the sidebar and the wide screens (NFR-USE-10). */
export const desk = () => setWidth(DESK);
