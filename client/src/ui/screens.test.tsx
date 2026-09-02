import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test } from "vitest";
import { App } from "../App";
import * as act from "../lib/actions";
import { createApi } from "../lib/api";
import { openDb } from "../lib/db";
import * as inv from "../lib/inventory";
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

test("editing an item records the change and shows it", async () => {
  const f = await fixture();
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Tent 1/ }));
  expect(location.pathname).toBe(`/items/${f.t1}`);
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Tent 1");

  await user.click(screen.getByRole("button", { name: "Edit" }));
  const before = store.pending.length;
  await user.clear(screen.getByLabelText("Condition"));
  await user.type(screen.getByLabelText("Condition"), "Pole bent");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await screen.findByText("Pole bent");
  const added = store.pending.slice(before);
  expect(added.map((e) => [e.type, e.payload])).toEqual([
    ["field_changed", { field: "condition", value: "Pole bent", old: null }],
  ]);
});

test("retiring hides an item until retired items are asked for", async () => {
  await fixture();
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Stove/ }));
  await user.click(screen.getByRole("button", { name: "Retire" }));
  await user.click(screen.getByRole("button", { name: "Really retire?" }));
  expect(await screen.findByText("Retired. Cannot be checked out.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Unretire" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(rows()).toEqual(["Tent 1Cold locker / shelf 4"]);
  await user.click(screen.getByLabelText("Show retired"));
  expect(rows()).toEqual(["StoveWarm locker"]);
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
  expect(inv.locations(store.state).map((l) => l.name)).toEqual(["Cold locker", "Dry locker"]);
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
