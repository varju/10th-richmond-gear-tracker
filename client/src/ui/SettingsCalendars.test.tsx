import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import type { CalendarFeed } from "../lib/api";
import { createApi } from "../lib/api";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { SettingsCalendars } from "./SettingsCalendars";

// Calendar feeds an Admin points at the group's own calendar (FR-RES-20). A fake server answers.
const T0 = 1_756_684_800_000;
let store: Store;
let calls: string[];
let feeds: CalendarFeed[];

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://x").pathname;
  const method = init?.method ?? "GET";
  calls.push(`${method} ${path}`);
  const json = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
  if (path === "/calendars" && method === "GET") return json({ feeds });
  if (path === "/calendars" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as { url: string; label: string };
    const feed: CalendarFeed = {
      id: "feed-2",
      label: body.label,
      url_redacted: new URL(body.url).host + new URL(body.url).pathname,
      added_at: T0,
      last_fetched_at: T0,
      last_error: null,
    };
    feeds = [...feeds, feed];
    return json({ feed });
  }
  const removed = /^\/calendars\/(.+)$/.exec(path);
  if (removed && method === "DELETE") {
    feeds = feeds.filter((f) => f.id !== removed[1]);
    return json({});
  }
  if (path === "/calendars/refresh" && method === "POST") return json({ feeds });
  return json({ error: "not_found", message: path }, 404);
};

beforeEach(async () => {
  calls = [];
  feeds = [
    {
      id: "feed-1",
      label: "Troop calendar",
      url_redacted: "calendar.example.org/troop.ics",
      added_at: T0,
      last_fetched_at: T0,
      last_error: null,
    },
  ];
  store = await openStore();
});

const user = userEvent.setup();
const mount = () => render(<SettingsCalendars store={store} api={createApi({ fetch: fetchFake, token: () => "t" })} />);

test("an Admin sees the feeds already added", async () => {
  mount();
  expect(await screen.findByText("Troop calendar")).toBeInTheDocument();
  expect(screen.getByText("calendar.example.org/troop.ics", { exact: false })).toBeInTheDocument();
});

test("pasting a URL adds a feed", async () => {
  mount();
  await screen.findByText("Troop calendar");
  await user.type(screen.getByLabelText("Feed URL"), "https://calendar.example.org/basic.ics?token=secret");
  await user.type(screen.getByLabelText("Label (optional)"), "Pack calendar");
  await user.click(screen.getByRole("button", { name: "Add feed" }));
  expect(await screen.findByText("Pack calendar")).toBeInTheDocument();
  // The token never leaves the request that adds it; the list only ever shows the redacted form.
  expect(screen.getByText("calendar.example.org/basic.ics", { exact: false })).toBeInTheDocument();
  expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
});

test("Remove takes a feed off the list", async () => {
  mount();
  await user.click(await screen.findByRole("button", { name: "Remove" }));
  expect(screen.queryByText("Troop calendar")).not.toBeInTheDocument();
  expect(screen.getByText("No feeds yet.")).toBeInTheDocument();
});

test("Refresh now asks the server to fetch every feed again", async () => {
  mount();
  await screen.findByText("Troop calendar");
  await user.click(screen.getByRole("button", { name: "Refresh now" }));
  expect(calls).toContain("POST /calendars/refresh");
});

test("not for users", async () => {
  await store.setMeta({ user: { id: "bea", name: "Bea", role: "user", active: true } });
  mount();
  expect(screen.getByRole("heading", { name: "Not found" })).toBeInTheDocument();
  expect(calls).toEqual([]);
});
