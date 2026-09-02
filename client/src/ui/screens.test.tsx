import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test } from "vitest";
import { App } from "../App";
import * as act from "../lib/actions";
import { createApi } from "../lib/api";
import { openDb } from "../lib/db";
import * as inv from "../lib/inventory";
import * as rep from "../lib/repairs";
import { navigate } from "../lib/router";
import { Store } from "../lib/store";

// The screens against a real store, with no server to talk to.
const T0 = 1_756_684_800_000;
let store: Store;
let clock: number;

const offline = async (): Promise<Response> => {
  throw new TypeError("Failed to fetch");
};

// The test DOM has no localStorage; a Map stands in.
if (!window.localStorage) {
  const memory = new Map<string, string>();
  const shim: Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear"> = {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
    clear: () => memory.clear(),
  };
  Object.defineProperty(window, "localStorage", { value: shim, configurable: true });
}

beforeEach(async () => {
  clock = T0;
  navigate("/");
  window.localStorage.clear();
  store = await Store.open(await openDb("test", new IDBFactory()), () => clock++);
  await store.setMeta({ token: "t", user: { id: "u1", name: "Alice", role: "admin", active: true }, cursor: 1 });
});

async function fixture() {
  const cold = await act.createLocation(store, "Cold locker");
  const warm = await act.createLocation(store, "Warm locker");
  const tents = await act.createType(store, "Tent");
  const t1 = await act.createItem(store, {
    name: "Tent 1",
    home_location_id: cold,
    sub_location: "shelf 4",
    type_id: tents,
  });
  const stove = await act.createItem(store, { name: "Stove", home_location_id: warm });
  return { cold, warm, tents, t1, stove };
}

const mount = () =>
  render(<App store={store} api={createApi({ fetch: offline, token: () => store.meta.token })} now={() => T0} />);

const rows = () => screen.getAllByRole("listitem").map((li) => within(li).getByRole("button").textContent);

test("the list narrows by query and by location", async () => {
  const f = await fixture();
  mount();
  const user = userEvent.setup();
  expect(screen.getByText("2 items")).toBeInTheDocument();
  expect(rows()).toEqual(["StoveWarm locker", "Tent 1Cold locker / shelf 4"]);

  await user.type(screen.getByLabelText("Search"), "shelf");
  expect(rows()).toEqual(["Tent 1Cold locker / shelf 4"]);
  expect(screen.getByText("1 item")).toBeInTheDocument();

  await user.clear(screen.getByLabelText("Search"));
  await user.selectOptions(screen.getByLabelText("Location"), f.warm);
  expect(rows()).toEqual(["StoveWarm locker"]);
});

test("an open ticket badges the row and counts on the home screen (FR-REP-05)", async () => {
  const f = await fixture();
  await rep.raiseTicket(store, f.t1, "zipper broken");
  mount();
  const user = userEvent.setup();
  expect(rows()).toEqual(["StoveWarm locker", "Tent 1RepairCold locker / shelf 4"]);

  await user.click(screen.getByRole("button", { name: "Needs repair · 1" }));
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Needs repair");
  // The ticket is in the open list and again in the history below it.
  expect(screen.getAllByRole("button", { name: /Tent 1/ })[0]).toHaveTextContent("Open · zipper broken");
});

test("editing an item records the change and shows it", async () => {
  const f = await fixture();
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Tent 1/ }));
  expect(location.pathname).toBe(`/items/${f.t1}`);
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Tent 1");

  await user.click(screen.getByRole("button", { name: "Edit" }));
  const before = store.pending.length;
  await user.clear(screen.getByLabelText("Supplier"));
  await user.type(screen.getByLabelText("Supplier"), "MEC");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await screen.findByText("MEC");
  const added = store.pending.slice(before);
  expect(added.map((e) => [e.type, e.payload])).toEqual([
    ["field_changed", { field: "supplier", value: "MEC", old: null }],
  ]);
});

test("retiring hides an item until retired items are asked for", async () => {
  await fixture();
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Stove/ }));
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.click(screen.getByLabelText("Retired"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Retired. Cannot be checked out.")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(rows()).toEqual(["Tent 1Cold locker / shelf 4"]);
  await user.click(screen.getByLabelText("Show retired"));
  expect(rows()).toEqual(["StoveWarm locker"]);

  // The same checkbox brings it back.
  await user.click(screen.getByRole("button", { name: /Stove/ }));
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.click(screen.getByLabelText("Retired"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("button", { name: "Check out" })).toBeInTheDocument();
});

test("a new item with a code is created, bound, and the walk goes on", async () => {
  const f = await fixture();
  window.localStorage.setItem("last-location", f.cold);
  navigate("/items/new?code=ABCDEFGH23");
  mount();
  const user = userEvent.setup();
  expect(screen.getByText(/will go on this item/)).toHaveTextContent("ABCDEFGH23");
  expect(screen.getByLabelText("Home location")).toHaveValue(f.cold);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  const before = store.pending.length;
  await user.type(screen.getByLabelText("Name"), "Tarp");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(location.pathname).toBe("/scan"));
  const added = store.pending.slice(before);
  expect(added.map((e) => e.type)).toEqual(["created", "code_bound"]);
  const id = added[0]!.entity_id;
  expect(inv.item(store.state, id)).toMatchObject({ name: "Tarp", home_location_id: f.cold });
  expect(inv.currentCode(store.state, id)?.id).toBe("ABCDEFGH23");
});

test("a new item without a code opens its page", async () => {
  await fixture();
  navigate("/items/new");
  mount();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Name"), "Tarp");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(location.pathname).toMatch(/^\/items\/[0-9A-Z]{26}$/));
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Tarp");
});

test("back with a half-typed new item asks; Keep editing stays, Save creates it, Discard drops it", async () => {
  await fixture();
  navigate("/items/new");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByText("Gear Tracker")).toBeInTheDocument();

  navigate("/items/new");
  await user.type(await screen.findByLabelText("Name"), "Lantern");
  await user.click(screen.getByRole("button", { name: "Back" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("Unsaved changes");
  await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toHaveValue("Lantern");

  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(inv.items(store.state).map((i) => i.name)).toContain("Lantern"));
  expect(await screen.findByText("Gear Tracker")).toBeInTheDocument();

  navigate("/items/new");
  await user.type(await screen.findByLabelText("Name"), "Nope");
  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
  expect(await screen.findByText("Gear Tracker")).toBeInTheDocument();
  expect(inv.items(store.state).map((i) => i.name)).not.toContain("Nope");
});

test("back with an unsaved group name asks; Save keeps it and goes home", async () => {
  navigate("/settings");
  mount();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Group name"), "10th Richmond");
  await user.click(screen.getByRole("button", { name: "Back" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(inv.group(store.state).name).toBe("10th Richmond"));
  expect(await screen.findByText("Gear Tracker")).toBeInTheDocument();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

test("back with a location typed but not added asks; Discard drops it", async () => {
  await fixture();
  navigate("/settings");
  mount();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("New location"), "Dry locker");
  await user.click(screen.getByRole("button", { name: "Back" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Discard" }));
  expect(await screen.findByText("Gear Tracker")).toBeInTheDocument();
  expect(inv.locations(store.state).map((l) => l.name)).toEqual(["Cold locker", "Warm locker"]);
});

test("deleting a location in use is refused and names the items", async () => {
  await fixture();
  navigate("/settings");
  mount();
  const user = userEvent.setup();
  expect(screen.getByText("Signed in as Alice")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete Cold locker" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("In use by Tent 1");
  expect(inv.locations(store.state)).toHaveLength(2);

  await user.click(screen.getByRole("button", { name: "Rename Warm locker" }));
  await user.clear(screen.getByLabelText("New name for Warm locker"));
  await user.type(screen.getByLabelText("New name for Warm locker"), "Dry locker");
  await user.click(screen.getByRole("button", { name: "Save Warm locker" }));
  await waitFor(() => expect(inv.locations(store.state).map((l) => l.name)).toEqual(["Cold locker", "Dry locker"]));
});

test("a group name that arrives after the settings page opens fills the form", async () => {
  navigate("/settings");
  mount();
  const nameField = screen.getByLabelText("Group name");
  expect(nameField).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save group" })).toBeDisabled();

  await act.setGroup(store, { name: "10th Richmond" });
  await waitFor(() => expect(nameField).toHaveValue("10th Richmond"));
  expect(screen.getByRole("button", { name: "Save group" })).toBeDisabled();

  const user = userEvent.setup();
  await user.type(nameField, " Sea Scouts");
  await user.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() => expect(inv.group(store.state).name).toBe("10th Richmond Sea Scouts"));
  expect(await screen.findByText("Saved")).toBeInTheDocument();
});

test("the overdue period is one group setting; blank means never (FR-OUT-14)", async () => {
  navigate("/settings");
  mount();
  const user = userEvent.setup();
  const days = screen.getByLabelText("Flag gear out longer than (days)");
  await user.type(days, "30");
  await user.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() => expect(inv.group(store.state).overdue_days).toBe(30));
  expect(days).toHaveValue(30);

  await user.clear(days);
  await user.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() => expect(inv.group(store.state).overdue_days ?? null).toBeNull());
});

test("settings are for admins; others see their account only", async () => {
  await store.setMeta({ user: { id: "u2", name: "Bob", role: "user", active: true } });
  navigate("/settings");
  mount();
  expect(screen.getByText("Signed in as Bob")).toBeInTheDocument();
  expect(screen.queryByText("Locations")).not.toBeInTheDocument();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("printing posts the sheet count with the bearer token and opens the PDF", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return new Response(new Blob(["%PDF"], { type: "application/pdf" }), { status: 200 });
  };
  const opened: string[] = [];
  URL.createObjectURL = () => "blob:codes";
  URL.revokeObjectURL = () => {};
  window.open = ((url: string) => {
    opened.push(url);
    return null;
  }) as typeof window.open;

  navigate("/settings");
  mount();
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText("Sheets"));
  await user.type(screen.getByLabelText("Sheets"), "3");
  await user.click(screen.getByRole("button", { name: "Print codes" }));

  expect(await screen.findByRole("link", { name: "Download codes.pdf" })).toHaveAttribute("href", "blob:codes");
  expect(opened).toEqual(["blob:codes"]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("/codes/sheets");
  expect(calls[0]!.init.method).toBe("POST");
  expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer t", "Content-Type": "application/json" });
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sheets: 3 });
});

test("a refused print shows the server's message", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "forbidden", message: "admins only" }), { status: 403 });
  navigate("/settings");
  mount();
  await userEvent.setup().click(screen.getByRole("button", { name: "Print codes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("admins only");
});
