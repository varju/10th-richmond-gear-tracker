import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import { App } from "./App";
import { createApi } from "./lib/api";
import { DAY_MS } from "./lib/clock";
import { openDb } from "./lib/db";
import { navigate } from "./lib/router";
import { Store } from "./lib/store";

const T0 = 1_756_684_800_000;
let store: Store;
let calls: string[];
let down = false;

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  if (down) throw new TypeError("Failed to fetch");
  const path = new URL(String(input), "http://x").pathname;
  calls.push(path);
  const json = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
  if (path === "/auth/sign-in") {
    const body = JSON.parse(String(init?.body)) as { password: string };
    if (body.password !== "pw") return json({ error: "unauthorized", message: "wrong email or password" }, 401);
    return json({
      token: "tok",
      user: { id: "u1", name: "Alice", role: "admin", active: true },
    });
  }
  if (path === "/sync/bootstrap")
    return json({
      snapshot: { item: { a: { name: "Tent" }, b: { name: "Stove" } } },
      cursor: 2,
      log_id: "log-one",
    });
  if (path === "/sync/pull") return json({ events: [], cursor: 2, log_id: "log-one" });
  if (path === "/sync/push") return json({ accepted: [], rejected: [], log_id: "log-one" });
  if (path.startsWith("/public/codes/"))
    return json({
      item: { name: "Tent" },
      group: { name: "10th Richmond", contact: "gear@example.org" },
    });
  return json({ error: "not_found", message: path }, 404);
};

beforeEach(async () => {
  calls = [];
  down = false;
  navigate("/");
  store = await Store.open(await openDb("test", new IDBFactory()), () => T0);
});

const mount = () =>
  render(<App store={store} api={createApi({ fetch: fetchFake, token: () => store.meta.token })} now={() => T0} />);

test("signing in bootstraps and shows the inventory", async () => {
  mount();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), "alice@example.org");
  await user.type(screen.getByLabelText("Password"), "nope");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("wrong email or password");

  await user.clear(screen.getByLabelText("Password"));
  await user.type(screen.getByLabelText("Password"), "pw");
  await user.click(screen.getByRole("button", { name: "Sign in" }));

  // Home opens on the two things a locker needs; the gear it pulled down is a search away.
  expect(
    await screen.findByText("Check out or return gear by scanning its code. Search by name for gear with no sticker."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check out" })).toBeInTheDocument();
  await user.type(screen.getByLabelText("Search"), "tent");
  expect(screen.getByRole("button", { name: /Tent/ })).toBeInTheDocument();
  expect(calls).toEqual(["/auth/sign-in", "/auth/sign-in", "/sync/bootstrap"]);
  expect(store.meta.cursor).toBe(2);
});

test("unsent work shows in the banner and blocks signing out", async () => {
  await store.setMeta({
    token: "tok",
    user: { id: "u1", name: "Alice", role: "admin", active: true },
    cursor: 2,
    log_id: "log-one",
  });
  down = true;
  await store.record({
    entity_type: "item",
    entity_id: "a",
    type: "note_added",
    actor_id: "u1",
    payload: { text: "x" },
  });
  navigate("/");
  mount();
  const user = userEvent.setup();
  expect(await screen.findByRole("status")).toHaveTextContent("1 unsent record · offline");
  await user.click(screen.getByRole("button", { name: "Menu" }));
  expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled();
  expect(screen.getByText("Sign out after your unsent records are sent.")).toBeInTheDocument();
});

test("a record made while online is pushed without anyone asking", async () => {
  await store.setMeta({
    token: "tok",
    user: { id: "u1", name: "Alice", role: "admin", active: true },
    cursor: 2,
    log_id: "log-one",
  });
  mount();
  await waitFor(() => expect(calls).toContain("/sync/pull"));
  calls = [];

  await store.record({
    entity_type: "item",
    entity_id: "a",
    type: "note_added",
    actor_id: "u1",
    payload: { text: "x" },
  });
  await waitFor(() => expect(calls).toContain("/sync/push"));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("records pending more than 3 days interrupt on open", async () => {
  // Record with a clock four days back, then open the app today.
  store = await Store.open(await openDb("test", new IDBFactory()), () => T0 - 4 * DAY_MS);
  await store.setMeta({
    token: "tok",
    user: { id: "u1", name: "Alice", role: "admin", active: true },
    cursor: 2,
    log_id: "log-one",
  });
  await store.record({
    entity_type: "item",
    entity_id: "a",
    type: "note_added",
    actor_id: "u1",
    payload: { text: "x" },
  });
  down = true;
  mount();
  expect(await screen.findByRole("alertdialog")).toHaveTextContent("1 record has been waiting 4 days ago");
  await userEvent.setup().click(screen.getByRole("button", { name: "Continue anyway" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
});

test("a sticker scanned while signed out shows the public page, not the sign-in form (FR-PUB-01)", async () => {
  navigate("/g/AAAAAAAAAA");
  mount();

  expect(await screen.findByRole("heading", { name: "10th Richmond" })).toBeInTheDocument();
  expect(screen.queryByText("Tent")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  expect(calls).toEqual(["/public/codes/AAAAAAAAAA"]);

  // A member who lands on one of our own stickers takes the way in.
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(screen.getByLabelText("Password")).toBeInTheDocument();
});

test("any other path while signed out is the sign-in form", async () => {
  navigate("/items/a");
  mount();
  expect(await screen.findByLabelText("Password")).toBeInTheDocument();
});
