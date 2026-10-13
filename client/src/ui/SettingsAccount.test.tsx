import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import { createApi } from "../lib/api";
import { openDb } from "../lib/db";
import { Store } from "../lib/store";
import { SettingsAccount } from "./SettingsAccount";

// Delete my account (FR-USR-25): two taps, needs the network, nothing erased.
const T0 = 1_756_684_800_000;
let store: Store;
let calls: string[];
let down: boolean;
let answer: { status: number; body: object };
let deleted: number;
let failSignOut: boolean;

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  if (down) throw new TypeError("Failed to fetch");
  const path = new URL(String(input), "http://x").pathname;
  calls.push(`${init?.method ?? "GET"} ${path}`);
  return new Response(JSON.stringify({ ...answer.body, server_time: T0 }), { status: answer.status });
};

beforeEach(async () => {
  calls = [];
  down = false;
  deleted = 0;
  failSignOut = false;
  answer = { status: 200, body: {} };
  store = await Store.open(await openDb("account", new IDBFactory()), () => T0);
  await store.setMeta({ token: "t", user: { id: "u2", name: "Bea", role: "user", active: true } });
});

const user = userEvent.setup();
const mount = () =>
  render(
    <SettingsAccount
      store={store}
      api={createApi({ fetch: fetchFake, token: () => "t" })}
      onDeleted={async () => {
        if (failSignOut) throw new Error("storage is full");
        deleted++;
      }}
    />,
  );

test("the first tap asks; the second deletes and signs out", async () => {
  mount();
  expect(screen.getByText(/This signs you out here, and you cannot sign in again/)).toBeInTheDocument();
  expect(screen.getByText(/Your other devices sign out the next time they connect/)).toBeInTheDocument();
  expect(screen.getByText(/Your name stays on the group's records/)).toBeInTheDocument();
  expect(screen.getByText(/An Admin can restore your access/)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Delete my account…" }));
  expect(calls).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Delete my account…" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Delete my account…" }));
  await user.click(screen.getByRole("button", { name: "Really delete? You cannot sign in again" }));
  expect(calls).toEqual(["POST /me/deactivate"]);
  expect(deleted).toBe(1);
});

test("offline, it says it needs a connection and stays signed in", async () => {
  down = true;
  mount();
  await user.click(screen.getByRole("button", { name: "Delete my account…" }));
  await user.click(screen.getByRole("button", { name: "Really delete? You cannot sign in again" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Deleting your account needs a connection.");
  expect(deleted).toBe(0);
});

test("the server's refusal is shown: the last Admin", async () => {
  answer = {
    status: 409,
    body: { error: "conflict", message: "you are the last Admin; make someone else an Admin first" },
  };
  mount();
  await user.click(screen.getByRole("button", { name: "Delete my account…" }));
  await user.click(screen.getByRole("button", { name: "Really delete? You cannot sign in again" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("make someone else an Admin first");
  expect(deleted).toBe(0);
});

test("gear still out is allowed, and the page says it stays under your name", async () => {
  await store.bootstrap(
    {
      item: {
        a: { name: "Tent", status: "out", holder_id: "u2" },
        b: { name: "Stove", status: "out", holder_id: "u2" },
      },
    },
    1,
    "log",
  );
  mount();
  expect(screen.getByRole("note")).toHaveTextContent("You still have 2 items out. They stay under your name");
  expect(screen.getByRole("button", { name: "Delete my account…" })).toBeEnabled();
});

test("unsent records come first", async () => {
  down = true;
  await store.record({
    entity_type: "item",
    entity_id: "a",
    type: "note_added",
    actor_id: "u2",
    payload: { text: "x" },
  });
  mount();
  expect(screen.getByRole("button", { name: "Delete my account…" })).toBeDisabled();
  expect(screen.getByText("Delete your account after your unsent records are sent.")).toBeInTheDocument();
});

const confirm = async () => {
  await user.click(screen.getByRole("button", { name: "Delete my account…" }));
  await user.click(screen.getByRole("button", { name: "Really delete? You cannot sign in again" }));
};

test.each([
  ["a lost reply, retried", 401, { error: "unauthorized", message: "this token is not valid" }],
  ["an Admin got there first", 403, { error: "deactivated", message: "this account has been deactivated" }],
])("%s: already deleted, so this device signs out", async (_, status, body) => {
  answer = { status, body };
  mount();
  await confirm();
  expect(deleted).toBe(1);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("another refusal is not taken as deleted", async () => {
  answer = { status: 403, body: { error: "forbidden", message: "no" } };
  mount();
  await confirm();
  expect(await screen.findByRole("alert")).toHaveTextContent("no");
  expect(deleted).toBe(0);
});

test("deleted, but this device could not clear its sign-in: it says so and is not stuck", async () => {
  failSignOut = true;
  mount();
  await confirm();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your account is deleted. This device signs out the next time it syncs.",
  );
  expect(screen.getByRole("button", { name: "Really delete? You cannot sign in again" })).toBeEnabled();
});

test("gear counts are this person's only, and a pool counts once", async () => {
  await store.bootstrap(
    {
      item: {
        a: { name: "Tent", status: "out", holder_id: "u2" },
        b: { name: "Stove", status: "out", holder_id: "someone" },
        c: { name: "Lost", status: "out", holder_id: "u2", missing: true },
        p: { name: "Pegs", pool: true, pool_in: 3, pool_out: { u2: 5, someone: 2 } },
      },
    },
    1,
    "log",
  );
  mount();
  expect(screen.getByRole("note")).toHaveTextContent("You still have 2 items out. They stay under your name");
});
