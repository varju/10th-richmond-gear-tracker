/** Page visibility for the tests. test-setup.ts puts it back after each test. */
export function setVisibility(state: "hidden" | "visible", announce = true): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  if (announce) document.dispatchEvent(new Event("visibilitychange"));
}

export function resetVisibility(): void {
  // @ts-expect-error removes the stub, uncovering the test DOM's own getter
  delete document.visibilityState;
}
