import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { navigate } from "../lib/router";
import { NATIVE_CLASS } from "../lib/scanner";
import type { Store } from "../lib/store";
import { ShellContext } from "../shell";
import { openStore, printCodes } from "./codeTestKit";
import { type FakeCamera, fakeCamera, stopFakeCamera } from "./scanTestKit";
import { DIAG_PRESS_MS, diagText, Scan } from "./Scan";
import { StockCheck } from "./StockCheck";

// The screens as the iPhone app runs them: the native scanner, through a stand-in for its plugin.
let store: Store;
let camera: FakeCamera;

beforeEach(async () => {
  store = await openStore();
  camera = fakeCamera();
});

afterEach(stopFakeCamera);

const shell = () => ({
  busy: false,
  manualBusy: false,
  outcome: null,
  now: Date.now,
  sync: async () => undefined,
  syncNow: async () => undefined,
  signOut: async () => {},
  store,
});

const see = () => document.documentElement.classList.contains(NATIVE_CLASS);

test("the menu over Scan stops the camera, and closing it starts it again on the new viewfinder", async () => {
  navigate("/scan");
  render(
    <ShellContext value={shell()}>
      <Scan store={store} native />
    </ShellContext>,
  );
  const user = userEvent.setup();
  await waitFor(() => expect(see()).toBe(true));

  await user.click(screen.getByRole("button", { name: "Menu" }));
  expect(see()).toBe(false);
  expect(camera.calls.at(-1)).toBe("stop");

  await user.click(screen.getByRole("button", { name: "Close menu" }));
  await waitFor(() => expect(see()).toBe(true));
  expect(camera.calls.filter((c) => c === "start")).toHaveLength(2);
});

test("the light stays on across the card, and says so when it comes back", async () => {
  await printCodes(store, ["AAAAAAAAAA"]);
  await act.bindCode(store, "AAAAAAAAAA", await act.createItem(store, { name: "Stove" }));
  navigate("/scan");
  render(
    <ShellContext value={shell()}>
      <Scan store={store} native />
    </ShellContext>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Light" }));
  await camera.scan("AAAAAAAAAA");
  await user.click(await screen.findByRole("button", { name: "Skip" }));
  expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
  expect(camera.torch).toEqual([true]);
});

test("the stock check walk offers the light, and it turns the torch on and off", async () => {
  const shelf = await act.createLocation(store, "Cold locker");
  await store.setMeta({ stock_check: { location_id: shelf, seen: [], started_at: 1 } });
  navigate("/stock-check");
  render(
    <ShellContext value={shell()}>
      <StockCheck store={store} native />
    </ShellContext>,
  );
  const user = userEvent.setup();
  const light = await screen.findByRole("button", { name: "Light" });
  expect(light).toHaveAttribute("aria-pressed", "false");
  await user.click(light);
  expect(light).toHaveAttribute("aria-pressed", "true");
  await user.click(light);
  expect(camera.torch).toEqual([true, false]);
});

/** A press held for `ms`, on fake timers so the suite does not wait. */
async function hold(el: Element, ms: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    fireEvent.pointerDown(el);
    await vi.advanceTimersByTimeAsync(ms);
    fireEvent.pointerUp(el);
  } finally {
    vi.useRealTimers();
  }
}

test("a long press on the viewfinder shows the scanner's state, and another hides it", async () => {
  navigate("/scan");
  const { container } = render(
    <ShellContext value={shell()}>
      <Scan store={store} native />
    </ShellContext>,
  );
  await camera.scan("not a gear code");
  const view = container.querySelector(".viewfinder")!;
  const press = () => hold(view, DIAG_PRESS_MS);
  expect(container.querySelector(".scan-diag")).toBeNull();
  await press();
  await waitFor(() =>
    expect(container.querySelector(".scan-diag")).toHaveTextContent(
      "page.received=1 page.dropped=0 page.live=true page.stopped=false page.paused=false page.web=false | handled=1 behindCard=0 rescans=0 afterBind=0 waiting=0 cardOpen=false cardItem=null bound=false",
    ),
  );
  await press();
  await waitFor(() => expect(container.querySelector(".scan-diag")).toBeNull());
});

test("a short press does not show the scanner's state", async () => {
  navigate("/scan");
  const { container } = render(
    <ShellContext value={shell()}>
      <Scan store={store} native />
    </ShellContext>,
  );
  await waitFor(() => expect(see()).toBe(true));
  const view = container.querySelector(".viewfinder")!;
  await hold(view, DIAG_PRESS_MS - 100);
  expect(container.querySelector(".scan-diag")).toBeNull();
});

test("a press that drifts does not show the scanner's state", async () => {
  navigate("/scan");
  const { container } = render(
    <ShellContext value={shell()}>
      <Scan store={store} native />
    </ShellContext>,
  );
  await waitFor(() => expect(see()).toBe(true));
  const view = container.querySelector(".viewfinder")!;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    fireEvent.pointerDown(view, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(view, { clientX: 100, clientY: 130 });
    await vi.advanceTimersByTimeAsync(DIAG_PRESS_MS);
  } finally {
    vi.useRealTimers();
  }
  expect(container.querySelector(".scan-diag")).toBeNull();
});

test("diagnostics text rounds fractions and names nested state by its parent", () => {
  expect(diagText({ zoom: 1.234, seen: 3, page: { live: true } })).toBe("zoom=1.23 seen=3 page.live=true");
});
