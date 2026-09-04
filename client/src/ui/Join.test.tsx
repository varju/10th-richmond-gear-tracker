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

let joinBodies: { link: string; name: string; email: string; password: string; device_id: string }[];

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://x").pathname;
  const json = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
  if (path === "/join") {
    const body = JSON.parse(String(init?.body)) as {
      link: string;
      name: string;
      email: string;
      password: string;
      device_id: string;
    };
    joinBodies.push(body);
    if (body.email === "taken@example.org") {
      return json({ error: "conflict", message: "an account with that email already exists; sign in instead" }, 409);
    }
    if (body.link !== "GOOD") return json({ error: "unauthorized", message: "this link is not valid" }, 401);
    return json({ token: "session", user: { id: "cal", name: body.name, role: "user", active: true } });
  }
  if (path !== "/auth/redeem") return json({ error: "not_found", message: path }, 404);
  const body = JSON.parse(String(init?.body)) as { token: string; password: string; device_id: string };
  bodies.push(body);
  if (body.token === "USED_INVITE")
    return json({ error: "invite_used", message: "you already have an account; sign in instead" }, 401);
  if (body.token === "USED_RESET")
    return json(
      { error: "reset_used", message: "this reset link has already been used; ask an Admin for a new one" },
      401,
    );
  if (body.token !== "GOOD") return json({ error: "unauthorized", message: "this link is not valid" }, 401);
  return json({ token: "session", user: { id: "bea", name: "Bea", role: "user", active: true } });
};

beforeEach(async () => {
  bodies = [];
  joinBodies = [];
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

test("a spent invite says the account exists, and offers sign in", async () => {
  navigate("/join?token=USED_INVITE");
  mount();
  await user.type(screen.getByLabelText("New password"), "battery staple");
  await user.type(screen.getByLabelText("Again"), "battery staple");
  await user.click(screen.getByRole("button", { name: "Set password and sign in" }));

  expect(await screen.findByText(/already have an account/)).toBeInTheDocument();
  expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(location.pathname).toBe("/");
});

test("a spent reset link says to ask an Admin, with no form left to retry", async () => {
  navigate("/join?token=USED_RESET");
  mount();
  await user.type(screen.getByLabelText("New password"), "battery staple");
  await user.type(screen.getByLabelText("Again"), "battery staple");
  await user.click(screen.getByRole("button", { name: "Set password and sign in" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Ask an Admin for a new one");
  expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
});

test("signed in already, it says to sign out first", async () => {
  await store.setMeta({ token: "t", user: { id: "alice", name: "Alice", role: "admin", active: true } });
  navigate("/join?token=GOOD");
  mount();
  expect(screen.getByText(/signed in as Alice/)).toBeInTheDocument();
  expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
});

// --- a standing join link, told apart by ?link= (FR-USR-19) --------------------------------

test("a standing join link asks for a name and email too, and signs this device in", async () => {
  navigate("/join?link=GOOD");
  const onJoined = mount();
  await user.type(screen.getByLabelText("Name"), "Cal");
  await user.type(screen.getByLabelText("Email"), "cal@example.org");
  await user.type(screen.getByLabelText("New password"), "battery staple");
  await user.type(screen.getByLabelText("Again"), "battery staple");
  await user.click(screen.getByRole("button", { name: "Set password and sign in" }));

  await waitFor(() => expect(onJoined).toHaveBeenCalled());
  expect(joinBodies).toEqual([
    {
      link: "GOOD",
      name: "Cal",
      email: "cal@example.org",
      password: "battery staple",
      device_id: store.meta.device_id,
    },
  ]);
  expect(store.meta.token).toBe("session");
  expect(store.meta.user?.name).toBe("Cal");
});

test("a standing link cannot be submitted before a name and email are filled in", async () => {
  navigate("/join?link=GOOD");
  mount();
  await user.type(screen.getByLabelText("New password"), "battery staple");
  await user.type(screen.getByLabelText("Again"), "battery staple");
  expect(screen.getByRole("button", { name: "Set password and sign in" })).toBeDisabled();
});

test("an email already in use shows the message with a Sign in button", async () => {
  navigate("/join?link=GOOD");
  mount();
  await user.type(screen.getByLabelText("Name"), "Cal");
  await user.type(screen.getByLabelText("Email"), "taken@example.org");
  await user.type(screen.getByLabelText("New password"), "battery staple");
  await user.type(screen.getByLabelText("Again"), "battery staple");
  await user.click(screen.getByRole("button", { name: "Set password and sign in" }));

  expect(await screen.findByText(/already have an account/)).toBeInTheDocument();
  expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(location.pathname).toBe("/");
});

test("a spent or made-up standing link shows the server's reason, not the conflict screen", async () => {
  navigate("/join?link=OLD");
  mount();
  await user.type(screen.getByLabelText("Name"), "Cal");
  await user.type(screen.getByLabelText("Email"), "cal@example.org");
  await user.type(screen.getByLabelText("New password"), "battery staple");
  await user.type(screen.getByLabelText("Again"), "battery staple");
  await user.click(screen.getByRole("button", { name: "Set password and sign in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("this link is not valid");
});
