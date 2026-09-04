import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { createApi } from "../lib/api";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { Notifications } from "./Notifications";

// Preferences live on the server (FR-USR-18). A fake server answers.
const T0 = 1_756_684_800_000;
let store: Store;
let calls: string[];
let saved: Record<string, boolean>;
let mailConfigured: boolean;
let offline: boolean;

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://x").pathname;
  const method = init?.method ?? "GET";
  calls.push(`${method} ${path}`);
  if (offline) throw new Error("offline");
  const json = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
  if (path === "/me/notifications" && method === "GET") {
    return json({ categories: saved, mail_configured: mailConfigured });
  }
  if (path === "/me/notifications" && method === "PUT") {
    saved = JSON.parse(String(init?.body)) as Record<string, boolean>;
    return json({ categories: saved, mail_configured: mailConfigured });
  }
  return json({ error: "not_found", message: path }, 404);
};

beforeEach(async () => {
  calls = [];
  saved = { found: false, repair: false, joined: false };
  mailConfigured = true;
  offline = false;
  store = await openStore();
});

const user = userEvent.setup();
const mount = () => render(<Notifications store={store} api={createApi({ fetch: fetchFake, token: () => "t" })} />);

test("every box starts unticked and saves itself when ticked", async () => {
  mount();
  const found = await screen.findByRole("checkbox", { name: "Gear reported found" });
  expect(found).not.toBeChecked();

  await user.click(found);
  expect(found).toBeChecked();
  expect(saved).toEqual({ found: true, repair: false, joined: false });
  expect(calls).toEqual(["GET /me/notifications", "PUT /me/notifications"]);

  await user.click(screen.getByRole("checkbox", { name: "New repair ticket" }));
  expect(saved).toEqual({ found: true, repair: true, joined: false });
});

test("unticking saves too", async () => {
  saved = { found: true, repair: false, joined: false };
  mount();
  const found = await screen.findByRole("checkbox", { name: "Gear reported found" });
  expect(found).toBeChecked();

  await user.click(found);
  expect(found).not.toBeChecked();
  expect(saved).toEqual({ found: false, repair: false, joined: false });
});

test("says so when no mail account is set up", async () => {
  mailConfigured = false;
  mount();
  expect(await screen.findByText(/No mail account is set up/)).toBeInTheDocument();
});

test("needs a connection", async () => {
  offline = true;
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Needs a connection");
});
