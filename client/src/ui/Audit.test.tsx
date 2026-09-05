import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { createApi, type ServerEvent } from "../lib/api";
import type { Store } from "../lib/store";
import { Audit } from "./Audit";
import { openStore } from "./codeTestKit";
import { alice, carol, seedUsers } from "./moveTestKit";

// The whole log on one screen, for an Admin, filtered (FR-USR-24).
const T0 = 1_756_684_800_000; // 2025-09-01 00:00 UTC, which is 2025-08-31 17:00 in Vancouver.

let store: Store;
let tent: string;
let asked: URLSearchParams[];
/** What the server holds, newest first, as /audit answers. */
let log: ServerEvent[];

let n = 0;
const serverEvent = (over: Partial<ServerEvent>): ServerEvent => ({
  id: `0400000000000000000000${String(++n).padStart(4, "0")}`,
  entity_type: "item",
  entity_id: tent,
  type: "checked_out",
  actor_id: "alice",
  device_id: "phone-a",
  device_seq: n,
  occurred_at: T0,
  clock_offset: 0,
  effective_at: T0,
  received_at: T0,
  seq: n,
  payload: {},
  ...over,
});

const fetchFake = async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(String(input), "http://x");
  asked.push(url.searchParams);
  const body = { events: log, more: log.length > 1 && url.searchParams.get("offset") === null, server_time: T0 };
  return new Response(JSON.stringify(body), { status: 200 });
};

const api = () => createApi({ fetch: fetchFake, token: () => "t" });
const mount = () => render(<Audit store={store} api={api()} />);
const user = userEvent.setup();

beforeEach(async () => {
  n = 0;
  asked = [];
  store = await openStore();
  await seedUsers(store, [alice, carol]);
  tent = await act.createItem(store, { name: "Tent 1" });
  log = [];
});

test("every kind of event on one screen, said in words, newest first", async () => {
  log = [
    serverEvent({
      entity_type: "user",
      entity_id: "carol",
      type: "field_changed",
      payload: { field: "role", value: "admin", old: "user" },
    }),
    serverEvent({ type: "field_changed", payload: { field: "name", value: "Tent 1", old: "Tent" } }),
    serverEvent({ type: "checked_out", actor_id: "carol" }),
  ];
  mount();

  const list = await screen.findByRole("list", { name: "Audit log" });
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual([
    "Role: user → admin · Carol · Alice · 2025-08-31 17:00",
    "Name: Tent → Tent 1 · Tent 1 · Alice · 2025-08-31 17:00",
    "Checked out · Tent 1 · Carol · 2025-08-31 17:00",
  ]);
});

test("narrowing by event, person, and a range of days asks the server, not the device", async () => {
  log = [serverEvent({})];
  mount();
  await screen.findByRole("list", { name: "Audit log" });

  await user.selectOptions(screen.getByLabelText("Event"), "Checked out");
  await user.selectOptions(screen.getByLabelText("Person"), "Carol");
  await user.type(screen.getByLabelText("From"), "2025-08-01");
  await user.type(screen.getByLabelText("To"), "2025-08-31");

  const last = asked.at(-1)!;
  expect(Object.fromEntries(last)).toEqual({
    type: "checked_out",
    actor: "carol",
    from: "2025-08-01",
    to: "2025-08-31",
  });
});

test("a long log comes a page at a time", async () => {
  log = [serverEvent({}), serverEvent({ type: "checked_in" })];
  mount();

  const list = await screen.findByRole("list", { name: "Audit log" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);

  // The next page holds the two older rows.
  log = [serverEvent({}), serverEvent({})];
  await user.click(screen.getByRole("button", { name: "Show more" }));
  expect(within(await screen.findByRole("list", { name: "Audit log" })).getAllByRole("listitem")).toHaveLength(4);
  expect(asked.at(-1)!.get("offset")).toBe("2");
  // That page said there was no more; the button goes.
  expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
});

test("a row that the next page repeats, because something newer landed in between, is drawn once", async () => {
  const [first, second] = [serverEvent({}), serverEvent({ type: "checked_in" })];
  log = [first, second];
  mount();
  await screen.findByRole("list", { name: "Audit log" });

  // Before the second page is asked for, a new event pushes `second` down to the next page.
  log = [second, serverEvent({ type: "recounted" })];
  await user.click(screen.getByRole("button", { name: "Show more" }));

  const list = await screen.findByRole("list", { name: "Audit log" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  expect(asked.at(-1)!.get("offset")).toBe("2");
});

test("with no signal it says so, because the whole log is on the server", async () => {
  const offline = createApi({
    fetch: vi.fn(async () => {
      throw new TypeError("failed to fetch");
    }),
    token: () => "t",
  });
  render(<Audit store={store} api={offline} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Needs a connection");
});

test("a User cannot read it", async () => {
  await store.setMeta({ user: { id: "carol", name: "Carol", role: "user", active: true } });
  mount();
  expect(await screen.findByText("Admins only.")).toBeInTheDocument();
  expect(asked).toEqual([]);
});
