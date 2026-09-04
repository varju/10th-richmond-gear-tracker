import { render, screen, waitFor, within } from "@testing-library/react";
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
let joinLinks: { id: string; created_by: string; created_by_name: string; created_at: number; expires_at: number }[];

const freshUsers = () => [
  { id: "alice", name: "Alice", role: "admin", active: true, email: "alice@example.org", has_password: true },
  { id: "bea", name: "Bea", role: "user", active: true, email: "bea@example.org", has_password: false },
];
let users: ReturnType<typeof freshUsers>;

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
  if (path === "/users/bea/edit") {
    if (sent.email === "alice@example.org") {
      return json({ error: "conflict", message: "an account with that email already exists" }, 409);
    }
    users[1] = { ...users[1]!, name: String(sent.name), email: String(sent.email) };
    return json({ user: users[1] });
  }
  if (path === "/users/alice/devices") return json({ devices: [{ device_id: store.meta.device_id, created_at: T0 }] });
  if (path === "/join-links" && init?.method === "GET") return json({ links: joinLinks });
  if (path === "/join-links" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { expiry_days: number; link: string };
    const made = {
      id: "link-1",
      created_by: "alice",
      created_by_name: "Alice",
      created_at: T0,
      expires_at: T0 + body.expiry_days * 86_400_000,
    };
    joinLinks = [made, ...joinLinks];
    return json({ ...made, token: "JOIN-TOKEN", url: body.link.replace("TOKEN", "JOIN-TOKEN"), qr_svg: "<svg />" });
  }
  if (path === "/join-links/link-1/revoke") {
    joinLinks = joinLinks.filter((l) => l.id !== "link-1");
    return json({ links: joinLinks });
  }
  return json({ error: "not_found", message: path }, 404);
};

beforeEach(async () => {
  calls = [];
  down = false;
  emailed = false;
  joinLinks = [];
  sent = {};
  users = freshUsers();
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

test("a deactivated user is hidden until an Admin asks to see them (FR-USR-04)", async () => {
  users.push({ id: "cal", name: "Cal", role: "user", active: false, email: "cal@example.org", has_password: true });
  mount();
  const list = await screen.findByRole("list", { name: "Users" });
  expect(within(list).queryByText(/Cal/)).not.toBeInTheDocument();

  await user.click(screen.getByRole("checkbox", { name: "Show deactivated" }));
  expect(within(list).getByText(/Cal/)).toBeInTheDocument();
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

test("an Admin fixes a name and an email (FR-USR-04)", async () => {
  mount();
  const list = await screen.findByRole("list", { name: "Users" });
  await user.click(within(list).getByRole("button", { name: /Bea/ }));
  await user.click(screen.getByRole("button", { name: "Edit name or email" }));

  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "Beatrice");
  await user.clear(screen.getByLabelText("Email"));
  await user.type(screen.getByLabelText("Email"), "beatrice@example.org");
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(calls).toContain("POST /users/bea/edit");
  expect(sent).toEqual({ name: "Beatrice", email: "beatrice@example.org" });
  await screen.findByText("beatrice@example.org · Invited");
  expect(within(list).getAllByRole("listitem")[1]).toHaveTextContent("Beatricebeatrice@example.org · Invited");
});

test("a clashing email is shown inline, the same way other errors are (FR-USR-04)", async () => {
  mount();
  const list = await screen.findByRole("list", { name: "Users" });
  await user.click(within(list).getByRole("button", { name: /Bea/ }));
  await user.click(screen.getByRole("button", { name: "Edit name or email" }));

  await user.clear(screen.getByLabelText("Email"));
  await user.type(screen.getByLabelText("Email"), "alice@example.org");
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("an account with that email already exists");
  // The form is still open, and Bea's row is unchanged.
  expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  expect(within(list).getAllByRole("listitem")[1]).toHaveTextContent("Beabea@example.org · Invited");
});

test("offline, the screen says it needs a connection", async () => {
  down = true;
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Needs a connection");
});

test("an Admin creates a standing join link and sees its URL and QR (FR-USR-19)", async () => {
  mount();
  await user.click(await screen.findByRole("button", { name: "Create join link" }));

  const status = await screen.findByRole("status");
  expect(status).toHaveTextContent(`${location.origin}/join?link=JOIN-TOKEN`);
  expect(status.querySelector(".qr svg")).toBeTruthy();
  expect(calls).toContain("POST /join-links");
  expect(sent).toEqual({ expiry_days: 7, link: `${location.origin}/join?link=TOKEN` });

  const list = await screen.findByRole("list", { name: "Join links" });
  expect(within(list).getByText(/Made by Alice/)).toBeInTheDocument();
});

test("a chosen expiry is sent to the server", async () => {
  mount();
  await user.selectOptions(await screen.findByLabelText("Expires after"), "1 day");
  await user.click(screen.getByRole("button", { name: "Create join link" }));
  await screen.findByRole("status");
  expect(sent.expiry_days).toBe(1);
});

test("revoking a join link removes it from the list", async () => {
  mount();
  await user.click(await screen.findByRole("button", { name: "Create join link" }));
  await user.click(await screen.findByRole("button", { name: "Done" }));

  const list = await screen.findByRole("list", { name: "Join links" });
  await user.click(within(list).getByRole("button", { name: "Revoke" }));
  expect(calls).toContain("POST /join-links/link-1/revoke");
  await waitFor(() => expect(screen.queryByRole("list", { name: "Join links" })).not.toBeInTheDocument());
});

test("not for users", async () => {
  await store.setMeta({ user: { id: "bea", name: "Bea", role: "user", active: true } });
  mount();
  expect(screen.getByRole("heading", { name: "Not found" })).toBeInTheDocument();
  expect(calls).toEqual([]);
});
