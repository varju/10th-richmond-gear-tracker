import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test, vi } from "vitest";
import { createApi } from "../lib/api";
import { openDb } from "../lib/db";
import { navigate } from "../lib/router";
import { Store } from "../lib/store";
import { Join } from "./Join";

// An invite or reset link lands here signed out (FR-USR-12).
const T0 = 1_756_684_800_000;
let store: Store;
let bodies: { token: string; password: string; device_id: string }[];

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://x").pathname;
  const json = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
  if (path !== "/auth/redeem") return json({ error: "not_found", message: path }, 404);
  const body = JSON.parse(String(init?.body)) as { token: string; password: string; device_id: string };
  bodies.push(body);
  if (body.token !== "GOOD") return json({ error: "unauthorized", message: "this link is not valid" }, 401);
  return json({ token: "session", user: { id: "bea", name: "Bea", role: "user", active: true } });
};

beforeEach(async () => {
  bodies = [];
  store = await Store.open(await openDb("join", new IDBFactory()), () => T0);
});

const user = userEvent.setup();
const mount = () => {
  const onJoined = vi.fn();
  render(
    <Join store={store} api={createApi({ fetch: fetchFake, token: () => store.meta.token })} onJoined={onJoined} />,
  );
  return onJoined;
};

test("a good link sets the password and signs this device in", async () => {
  navigate("/join?token=GOOD");
  const onJoined = mount();
  await user.type(screen.getByLabelText("New password"), "battery staple");
  await user.type(screen.getByLabelText("Again"), "battery staple");
  await user.click(screen.getByRole("button", { name: "Set password and sign in" }));

  await waitFor(() => expect(onJoined).toHaveBeenCalled());
  expect(bodies).toEqual([{ token: "GOOD", password: "battery staple", device_id: store.meta.device_id }]);
  expect(store.meta.token).toBe("session");
  expect(store.meta.user?.name).toBe("Bea");
});

test("short or mismatched passwords never reach the server", async () => {
  navigate("/join?token=GOOD");
  mount();
  await user.type(screen.getByLabelText("New password"), "short");
  await user.type(screen.getByLabelText("Again"), "short");
  await user.click(screen.getByRole("button", { name: "Set password and sign in" }));
  expect(screen.getByRole("alert")).toHaveTextContent("at least 8 characters");

  await user.type(screen.getByLabelText("New password"), "-enough");
  await user.click(screen.getByRole("button", { name: "Set password and sign in" }));
  expect(screen.getByRole("alert")).toHaveTextContent("differ");
  expect(bodies).toEqual([]);
});

test("a spent or made-up link shows the server's reason", async () => {
  navigate("/join?token=OLD");
  mount();
  await user.type(screen.getByLabelText("New password"), "battery staple");
  await user.type(screen.getByLabelText("Again"), "battery staple");
  await user.click(screen.getByRole("button", { name: "Set password and sign in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("this link is not valid");
  expect(store.meta.token).toBeUndefined();
});

test("signed in already, it says to sign out first", async () => {
  await store.setMeta({ token: "t", user: { id: "alice", name: "Alice", role: "admin", active: true } });
  navigate("/join?token=GOOD");
  mount();
  expect(screen.getByText(/signed in as Alice/)).toBeInTheDocument();
  expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
});
