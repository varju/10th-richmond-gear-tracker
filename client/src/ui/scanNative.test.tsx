import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { navigate } from "../lib/router";
import { NATIVE_CLASS } from "../lib/scanner";
import type { Store } from "../lib/store";
import { ShellContext } from "../shell";
import { openStore, printCodes } from "./codeTestKit";
import { Scan } from "./Scan";
import { StockCheck } from "./StockCheck";

// The screens as the iPhone app runs them: the native scanner, through a stand-in for its plugin.
let store: Store;
let calls: string[];
let torch: boolean[];

beforeEach(async () => {
  store = await openStore();
  calls = [];
  torch = [];
  const listeners = new Map<string, (data: unknown) => void>();
  vi.stubGlobal("Capacitor", {
    isPluginAvailable: () => true,
    nativePromise: async (_plugin: string, method: string, args: { on?: boolean }) => {
      calls.push(method);
      if (method === "torch") torch.push(args.on === true);
      // As the plugin does: the camera runs once start lands, and says so.
      if (method === "start") setTimeout(() => listeners.get("ready")?.({ torch: true }), 0);
      return undefined;
    },
    addListener: (_plugin: string, event: string, callback: (data: unknown) => void) => {
      listeners.set(event, callback);
      return { remove: async () => undefined };
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove(NATIVE_CLASS);
});

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
  expect(calls.at(-1)).toBe("stop");

  await user.click(screen.getByRole("button", { name: "Close menu" }));
  await waitFor(() => expect(see()).toBe(true));
  expect(calls.filter((c) => c === "start")).toHaveLength(2);
});

test("the light stays on across the card and typing, and says so when it comes back", async () => {
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
  await user.click(screen.getByRole("button", { name: "Type a code instead" }));
  expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
  await user.type(screen.getByLabelText("Code or URL"), "AAAAAAAAAA");
  await user.click(screen.getByRole("button", { name: "Go" }));
  await user.click(await screen.findByRole("button", { name: "Skip" }));
  expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
  expect(torch).toEqual([true]);
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
  expect(torch).toEqual([true, false]);
});
