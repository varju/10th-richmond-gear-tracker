import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import { createApi } from "../lib/api";
import { openDb } from "../lib/db";
import { Store } from "../lib/store";
import { SettingsDevices } from "./SettingsDevices";

// "Your devices" in Settings (FR-USR-17), the same list Users.tsx shows an Admin for someone else.
const T0 = 1_756_684_800_000;
let store: Store;
let devices: { device_id: string; created_at: number }[];
let calls: string[];

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://x").pathname;
  calls.push(`${init?.method ?? "GET"} ${path}`);
  const json = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
  if (path === "/users/u2/devices") return json({ devices });
  const revoked = path.match(/^\/users\/u2\/devices\/(.+)\/revoke$/);
  if (revoked) {
    devices = devices.filter((d) => d.device_id !== revoked[1]);
    return json({ devices });
  }
  return json({ error: "not_found", message: path }, 404);
};

beforeEach(async () => {
  calls = [];
  store = await Store.open(await openDb("devices", new IDBFactory()), () => T0);
  await store.setMeta({ token: "t", user: { id: "u2", name: "Bob", role: "user", active: true } });
  devices = [
    { device_id: store.meta.device_id, created_at: T0 },
    { device_id: "phone-other", created_at: T0 - 86_400_000 },
    { device_id: "mcp-assistant", created_at: T0 - 3_600_000 },
  ];
});

const user = userEvent.setup();
const mount = () => render(<SettingsDevices store={store} api={createApi({ fetch: fetchFake, token: () => "t" })} />);

test("Settings shows a non-admin their own devices; the one in use cannot be revoked", async () => {
  mount();
  expect(screen.getByRole("heading", { name: "Your devices" })).toBeInTheDocument();

  const list = await screen.findByRole("list", { name: "Your devices" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows.map((r) => r.textContent)).toEqual([
    expect.stringContaining("This device"),
    expect.stringContaining("Device"),
    expect.stringContaining("Assistant"),
  ]);

  const revokeButtons = within(list).getAllByRole("button", { name: "Revoke" });
  expect(revokeButtons[0]).toBeDisabled();
  expect(revokeButtons[0]).toHaveAttribute("title", "Sign out instead");

  await user.click(revokeButtons[1]!);
  expect(await within(list).findAllByRole("listitem")).toHaveLength(2);
  expect(calls).toContain("POST /users/u2/devices/phone-other/revoke");
});

test("offline, the devices section says so quietly; no alert (settings are opened in lockers with no signal)", async () => {
  store = await Store.open(await openDb("devices-offline", new IDBFactory()), () => T0);
  await store.setMeta({ token: "t", user: { id: "u2", name: "Bob", role: "user", active: true } });
  const offline: typeof fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  render(<SettingsDevices store={store} api={createApi({ fetch: offline, token: () => "t" })} />);
  expect(await screen.findByText("Needs a connection to list devices.")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a revoke that fails offline does alert: the person tapped something", async () => {
  const droppedFetch: typeof fetch = async (input, init) =>
    new URL(String(input), "http://x").pathname.includes("/revoke")
      ? Promise.reject(new TypeError("Failed to fetch"))
      : fetchFake(input, init);
  render(<SettingsDevices store={store} api={createApi({ fetch: droppedFetch, token: () => "t" })} />);

  const list = await screen.findByRole("list", { name: "Your devices" });
  await user.click(within(list).getAllByRole("button", { name: "Revoke" })[1]!);
  expect(await screen.findByRole("alert")).toHaveTextContent("Needs a connection.");
});
