import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { navigate } from "../lib/router";
import type { Shell } from "../shell";
import type { Store } from "../lib/store";
import { localMinute } from "../lib/time";
import { openStore } from "./codeTestKit";
import { SettingsUnsent } from "./SettingsUnsent";

const T0 = 1_756_684_800_000;
let store: Store;

const shell: Shell = {
  busy: false,
  manualBusy: false,
  outcome: null,
  now: () => T0,
  sync: async () => undefined,
  syncNow: async () => undefined,
  signOut: async () => {},
};

beforeEach(async () => {
  store = await openStore();
  navigate("/settings/unsent", true);
});

const mount = (over: Partial<Shell> = {}) => render(<SettingsUnsent store={store} shell={{ ...shell, ...over }} />);

test("nothing pending says so", () => {
  mount();
  expect(screen.getByText("Nothing waiting. Everything on this device has been sent.")).toBeInTheDocument();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

test("pending records are listed oldest first, with what and when", async () => {
  await act.createItem(store, { name: "Tent 1" });
  await act.createItem(store, { name: "Stove" });
  mount();

  const rows = within(screen.getByRole("list", { name: "Unsent records" })).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("Tent 1");
  expect(rows[1]).toHaveTextContent("Stove");
  const [first, second] = store.pending;
  expect(rows[0]).toHaveTextContent(localMinute(first!.occurred_at));
  expect(rows[1]).toHaveTextContent(localMinute(second!.occurred_at));
});

test("a failed sync shows its message once", async () => {
  await act.createItem(store, { name: "Tent 1" });
  mount({ outcome: { ok: false, reason: "error", message: "server said 500" } });
  expect(screen.getAllByText(/server said 500/)).toHaveLength(1);
});

test("a code's bind and release both name the item", async () => {
  const tent = await act.createItem(store, { name: "Tent 1" });
  await act.bindCode(store, "CODE1", tent);
  await act.releaseCode(store, "CODE1");
  mount();
  const rows = within(screen.getByRole("list", { name: "Unsent records" })).getAllByRole("listitem");
  const code = rows.filter((r) => /Code (assigned|freed)/.test(r.textContent ?? ""));
  expect(code).toHaveLength(2);
  for (const r of code) expect(r).toHaveTextContent("Tent 1");
});

test("Send now asks for a sync, and waits while one the person started runs", async () => {
  const syncNow = vi.fn(async () => undefined);
  const view = mount({ syncNow });
  await userEvent.setup().click(screen.getByRole("button", { name: "Send now" }));
  expect(syncNow).toHaveBeenCalledTimes(1);

  view.unmount();
  mount({ syncNow, manualBusy: true });
  expect(screen.getByRole("button", { name: "Send now" })).toBeDisabled();
});
