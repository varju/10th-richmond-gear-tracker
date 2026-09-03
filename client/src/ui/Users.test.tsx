import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { createApi } from "../lib/api";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { Users } from "./Users";

// Admin user management is a set of server calls (FR-USR-04, FR-USR-14). A fake server answers them.
const T0 = 1_756_684_800_000;
let store: Store;
let calls: string[];
let down: boolean;
let devices: { device_id: string; created_at: number }[];
let emailed: boolean;
let sent: Record<string, unknown>;

const users = [
  { id: "alice", name: "Alice", role: "admin", active: true, email: "alice@example.org", has_password: true },
  { id: "bea", name: "Bea", role: "user", active: true, email: "bea@example.org", has_password: false },
];

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  if (down) throw new TypeError("Failed to fetch");
  const path = new URL(String(input), "http://x").pathname;
  calls.push(`${init?.method ?? "GET"} ${path}`);
  const json = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
  if (init?.body) sent = JSON.parse(String(init.body));
  if (path === "/users") return json({ users });
  if (path === "/users/invite") return json({ user_id: "cal", token: "INVITE-TOKEN", emailed });
  if (path === "/users/bea/reset-link") return json({ token: "RESET-TOKEN", emailed });
  if (path === "/users/bea/devices") return json({ devices });
  if (path === "/users/bea/devices/phone-lost/revoke") {
    devices = devices.filter((d) => d.device_id !== "phone-lost");
    return json({ devices });
  }
  if (path === "/users/bea/deactivate") return json({ user: { ...users[1], active: false } });
  if (path === "/users/alice/devices") return json({ devices: [{ device_id: store.meta.device_id, created_at: T0 }] });
  return json({ error: "not_found", message: path }, 404);
};

beforeEach(async () => {
  calls = [];
  down = false;
  emailed = false;
  sent = {};
  devices = [
    { device_id: "phone-lost", created_at: T0 },
    { device_id: "phone-kept", created_at: T0 - 86_400_000 },
  ];
  store = await openStore();
});

const user = userEvent.setup();
const mount = () => render(<Users store={store} api={createApi({ fetch: fetchFake, token: () => "t" })} />);

test("lists the group and revokes one device without touching the person (FR-USR-14)", async () => {
  mount();
  const list = await screen.findByRole("list", { name: "Users" });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["Alicealice@example.org · Admin", "Beabea@example.org · Invited"]);

  await user.click(within(list).getByRole("button", { name: /Bea/ }));
  const phones = await screen.findByRole("list", { name: "Devices of Bea" });
  expect(within(phones).getAllByRole("listitem")).toHaveLength(2);

  await user.click(within(phones).getAllByRole("button", { name: "Revoke" })[0]!);
  expect(await within(phones).findAllByRole("listitem")).toHaveLength(1);
  expect(calls).toContain("POST /users/bea/devices/phone-lost/revoke");
  expect(calls.filter((c) => c.includes("deactivate"))).toEqual([]);
});

test("an Admin's own device cannot be revoked here; sign out instead", async () => {
  mount();
  await user.click(await screen.findByRole("button", { name: /Alice/ }));
  const phones = await screen.findByRole("list", { name: "Devices of Alice" });
  expect(phones).toHaveTextContent("This device");
  expect(within(phones).getByRole("button", { name: "Revoke" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Deactivate" })).toBeDisabled();
});

test("inviting shows a one-time link to pass on (FR-USR-12)", async () => {
  mount();
  await user.click(await screen.findByRole("button", { name: "Invite someone" }));
  await user.type(screen.getByLabelText("Name"), "Cal");
  await user.type(screen.getByLabelText("Email"), "cal@example.org");
  await user.click(screen.getByRole("button", { name: "Invite" }));

  const status = await screen.findByRole("status");
  expect(status).toHaveTextContent("Send this link to Cal");
  expect(status).toHaveTextContent(`${location.origin}/join?token=INVITE-TOKEN`);
  expect(calls).toContain("POST /users/invite");
});

test("a reset link is the same kind of link", async () => {
  mount();
  await user.click(await screen.findByRole("button", { name: /Bea/ }));
  await user.click(screen.getByRole("button", { name: "Reset link" }));
  expect(await screen.findByRole("status")).toHaveTextContent("/join?token=RESET-TOKEN");
});

test("when the server has a mail account, it says the invite was emailed (FR-USR-15)", async () => {
  emailed = true;
  mount();
  await user.click(await screen.findByRole("button", { name: "Invite someone" }));
  await user.type(screen.getByLabelText("Name"), "Cal");
  await user.type(screen.getByLabelText("Email"), "cal@example.org");
  await user.click(screen.getByRole("button", { name: "Invite" }));

  const status = await screen.findByRole("status");
  expect(status).toHaveTextContent("Emailed to Cal");
  expect(status).toHaveTextContent(`${location.origin}/join?token=INVITE-TOKEN`);
  // The server fills TOKEN in, so it never needs to know its own public address.
  expect(sent.link).toBe(`${location.origin}/join?token=TOKEN`);
});

test("offline, the screen says it needs a connection", async () => {
  down = true;
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Needs a connection");
});

test("not for users", async () => {
  await store.setMeta({ user: { id: "bea", name: "Bea", role: "user", active: true } });
  mount();
  expect(screen.getByRole("heading", { name: "Not found" })).toBeInTheDocument();
  expect(calls).toEqual([]);
});
