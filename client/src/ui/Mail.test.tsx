import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { createApi } from "../lib/api";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { Mail } from "./Mail";

// Mail is set up on the server (FR-USR-15). A fake server answers.
const T0 = 1_756_684_800_000;
let store: Store;
let calls: string[];
let saved: Record<string, unknown> | null;
let refuse: boolean;

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://x").pathname;
  const method = init?.method ?? "GET";
  calls.push(`${method} ${path}`);
  const json = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
  const described = saved && {
    host: saved.host,
    port: saved.port,
    encryption: saved.encryption,
    username: saved.username,
    from_address: saved.from_address,
    has_password: Boolean(saved.password),
  };
  if (path === "/mail" && method === "GET") return json({ mail: described });
  if (path === "/mail" && method === "PUT") {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    saved = { ...body, password: body.password || saved?.password || "" };
    return json({ mail: { ...body, has_password: Boolean(saved.password) } });
  }
  if (path === "/mail" && method === "DELETE") {
    saved = null;
    return json({ mail: null });
  }
  if (path === "/mail/test") {
    if (refuse) return json({ error: "bad_request", message: "the mail server refused it: nope" }, 400);
    return json({ sent_to: "alice@example.org" });
  }
  return json({ error: "not_found", message: path }, 404);
};

beforeEach(async () => {
  calls = [];
  saved = null;
  refuse = false;
  store = await openStore();
});

const user = userEvent.setup();
const mount = () => render(<Mail store={store} api={createApi({ fetch: fetchFake, token: () => "t" })} />);

async function fillIn() {
  await user.type(await screen.findByLabelText("Server"), "smtp.example.org");
  await user.type(screen.getByLabelText("Username"), "gear@example.org");
  await user.type(screen.getByLabelText("Password"), "app-password");
  await user.type(screen.getByLabelText("Send from"), "gear@example.org");
}

test("an Admin fills in one account and sends a test to themselves (FR-USR-16)", async () => {
  mount();
  await fillIn();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
  expect(saved).toMatchObject({
    host: "smtp.example.org",
    port: 465,
    encryption: "ssl",
    username: "gear@example.org",
    password: "app-password",
    from_address: "gear@example.org",
  });

  await user.click(screen.getByRole("button", { name: "Send a test" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Test message sent to alice@example.org.");
});

test("the password is never read back, and a blank one keeps it", async () => {
  saved = {
    host: "smtp.example.org",
    port: 587,
    encryption: "starttls",
    username: "gear@example.org",
    password: "app-password",
    from_address: "gear@example.org",
  };
  mount();
  // The form shows before the saved settings arrive; the placeholder follows them.
  const password = await screen.findByLabelText("Password");
  await waitFor(() => expect(password).toHaveAttribute("placeholder", "Kept"));
  expect(password).toHaveValue("");

  await user.clear(screen.getByLabelText("Port"));
  await user.type(screen.getByLabelText("Port"), "465");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved.");
  expect(saved).toMatchObject({ port: 465, password: "app-password" });
});

test("a refused test message says why", async () => {
  refuse = true;
  saved = {
    host: "smtp.example.org",
    port: 465,
    encryption: "ssl",
    username: "",
    password: "",
    from_address: "g@x.org",
  };
  mount();
  await user.click(await screen.findByRole("button", { name: "Send a test" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("the mail server refused it");
});

test("removing the account goes back to links copied by hand (FR-USR-12)", async () => {
  saved = {
    host: "smtp.example.org",
    port: 465,
    encryption: "ssl",
    username: "",
    password: "",
    from_address: "g@x.org",
  };
  mount();
  await user.click(await screen.findByRole("button", { name: "Remove this account" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Removed.");
  expect(saved).toBeNull();
  expect(screen.getByLabelText("Server")).toHaveValue("");
});

test("not for users", async () => {
  await store.setMeta({ user: { id: "bea", name: "Bea", role: "user", active: true } });
  mount();
  expect(screen.getByRole("heading", { name: "Not found" })).toBeInTheDocument();
  expect(calls).toEqual([]);
});
