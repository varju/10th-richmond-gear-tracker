import { act as reactAct, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test } from "vitest";
import { App } from "../App";
import * as act from "../lib/actions";
import { createApi } from "../lib/api";
import { openDb } from "../lib/db";
import * as inv from "../lib/inventory";
import { checkOut } from "../lib/movement";
import * as rep from "../lib/repairs";
import { navigate } from "../lib/router";
import { Store } from "../lib/store";
import { printCodes } from "./codeTestKit";

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
  const t1 = await act.createItem(store, { name: "Tent 1", home_location_id: cold, sub_location: "shelf 4" });
  const stove = await act.createItem(store, { name: "Stove", home_location_id: warm });
  return { cold, warm, t1, stove };
}

const mount = (fetchFn: typeof fetch = offline, base = "") =>
  render(<App store={store} api={createApi({ fetch: fetchFn, base, token: () => store.meta.token })} now={() => T0} />);

const rows = () => screen.getAllByRole("listitem").map((li) => within(li).getByRole("button").textContent);

test("the list narrows by query and by location", async () => {
  const f = await fixture();
  navigate("/items");
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
  navigate("/items");
  mount();
  const user = userEvent.setup();
  expect(rows()).toEqual(["StoveWarm locker", "Tent 1RepairCold locker / shelf 4"]);

  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(screen.getByRole("button", { name: "Menu" }));
  await user.click(screen.getByRole("button", { name: "Reports" }));
  await user.click(screen.getByRole("button", { name: "Needs repair · 1" }));
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Needs repair");
  // The ticket is in the open list and again in the history below it.
  expect(screen.getAllByRole("button", { name: /Tent 1/ })[0]).toHaveTextContent("Open · zipper broken");
});

test("editing an item records the change and shows it", async () => {
  const f = await fixture();
  navigate("/items");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Tent 1/ }));
  expect(location.pathname).toBe(`/items/${f.t1}`);
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Tent 1");

  await user.click(screen.getByRole("button", { name: "Edit" }));
  const before = store.pending.length;
  await user.clear(screen.getByLabelText("Price"));
  await user.type(screen.getByLabelText("Price"), "249.99");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await screen.findByText("$249.99");
  const added = store.pending.slice(before);
  expect(added.map((e) => [e.type, e.payload])).toEqual([
    ["field_changed", { field: "price", value: 249.99, old: null }],
  ]);
});

test("retiring hides an item until retired items are asked for", async () => {
  await fixture();
  navigate("/items");
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
  // A scanned code, so the scanner is the screen behind this one.
  navigate("/scan");
  navigate("/items/new?code=ABCDEFGH23");
  mount();
  const user = userEvent.setup();
  expect(screen.getByText(/will go on this item/)).toHaveTextContent("ABCDEFGH23");
  // Nothing is guessed: the home starts empty.
  expect(screen.getByLabelText("Home location")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  const before = store.pending.length;
  await user.type(screen.getByLabelText("Name"), "Tarp");
  await user.selectOptions(screen.getByLabelText("Home location"), f.cold);
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

test("Add another keeps the form up; the template checkbox carries the values over", async () => {
  const f = await fixture();
  navigate("/items/new");
  mount();
  const user = userEvent.setup();
  expect(screen.queryByLabelText("Copy values above")).not.toBeInTheDocument();
  await user.click(screen.getByLabelText("Add another after saving"));
  await user.click(screen.getByLabelText("Copy values above"));
  await user.type(screen.getByLabelText("Name"), "Tarp 1");
  await user.selectOptions(screen.getByLabelText("Home location"), f.cold);
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Saved · Tarp 1")).toBeInTheDocument();
  expect(location.pathname).toBe("/items/new");
  expect(screen.getByLabelText("Home location")).toHaveValue(f.cold);

  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "Tarp 2");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      inv
        .items(store.state)
        .map((i) => i.name)
        .sort(),
    ).toContain("Tarp 2"),
  );
  expect(
    inv
      .items(store.state)
      .filter((i) => i.name?.startsWith("Tarp"))
      .map((i) => i.home_location_id),
  ).toEqual([f.cold, f.cold]);
});

test("unticking Add another hides and resets the Copy values checkbox", async () => {
  await fixture();
  navigate("/items/new");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("Add another after saving"));
  await user.click(screen.getByLabelText("Copy values above"));
  await user.click(screen.getByLabelText("Add another after saving"));
  expect(screen.queryByLabelText("Copy values above")).not.toBeInTheDocument();

  await user.click(screen.getByLabelText("Add another after saving"));
  expect(screen.getByLabelText("Copy values above")).not.toBeChecked();
});

test("Add another on its own clears the form", async () => {
  const f = await fixture();
  navigate("/items/new");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("Add another after saving"));
  await user.type(screen.getByLabelText("Name"), "Tarp 1");
  await user.selectOptions(screen.getByLabelText("Home location"), f.cold);
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Saved · Tarp 1")).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toHaveValue("");
  expect(screen.getByLabelText("Home location")).toHaveValue("");
});

test("a new item remembers the last categories picked on this device (FR-SET-07)", async () => {
  await fixture();
  navigate("/items/new");
  const first = mount();
  const noCats = within(screen.getByRole("group", { name: "Categories" }));
  expect(noCats.queryAllByRole("checkbox")).toHaveLength(0);
  expect(noCats.getByRole("button", { name: "New category…" })).toBeInTheDocument();
  first.unmount();

  await act.createCategory(store, "Camp kitchen");
  const cold = await act.createCategory(store, "Cold weather");
  navigate("/items/new");
  const second = mount();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Name"), "Stove 2");
  await user.click(screen.getByLabelText("Cold weather"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(store.meta.last_category_ids).toEqual([cold]));
  second.unmount();

  navigate("/items/new");
  mount();
  expect(screen.getByLabelText("Cold weather")).toBeChecked();
  expect(screen.getByLabelText("Camp kitchen")).not.toBeChecked();
});

test("New category adds one, unnamed items included, and ticks it on the item", async () => {
  await fixture();
  navigate("/items/new");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New category…" }));
  await user.type(screen.getByLabelText("New category"), "Camp kitchen");
  await user.click(screen.getByRole("button", { name: "Add" }));

  expect(await screen.findByLabelText("Camp kitchen")).toBeChecked();
  expect(inv.categories(store.state).map((c) => c.name)).toEqual(["Camp kitchen"]);
});

test("New category with a name already in use ticks the existing one instead of making a second", async () => {
  await act.createCategory(store, "Camp kitchen");
  await fixture();
  navigate("/items/new");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New category…" }));
  await user.type(screen.getByLabelText("New category"), "camp KITCHEN");
  await user.click(screen.getByRole("button", { name: "Add" }));

  expect(await screen.findByLabelText("Camp kitchen")).toBeChecked();
  expect(inv.categories(store.state).map((c) => c.name)).toEqual(["Camp kitchen"]);
});

test("New category rejects a blank name", async () => {
  await fixture();
  navigate("/items/new");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New category…" }));
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("New category")).not.toBeInTheDocument();
  expect(inv.categories(store.state)).toEqual([]);
});

test("ticking several saves the name and the one in hand as #1 (FR-INV-21, S-BOOT-03)", async () => {
  const f = await fixture();
  navigate("/scan");
  navigate("/items/new?code=ABCDEFGH23");
  mount();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Name"), "3x3 tarp");
  await user.click(screen.getByLabelText("We have several of these"));
  await user.selectOptions(screen.getByLabelText("Default home"), f.warm);
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(location.pathname).toBe("/scan"));
  const generic = inv.generics(store.state).find((g) => g.name === "3x3 tarp")!;
  const units = inv.unitsOf(store.state, generic.id);
  expect(units.map((u) => inv.displayName(store.state, u))).toEqual(["3x3 tarp #1"]);
  expect(units[0]).toMatchObject({ home_location_id: f.warm });
  expect(inv.currentCode(store.state, units[0]!.id)?.id).toBe("ABCDEFGH23");
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
  navigate("/settings/group");
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
  navigate("/settings/locations");
  mount();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("New location"), "Dry locker");
  await user.click(screen.getByRole("button", { name: "Back" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Discard" }));
  expect(await screen.findByText("Gear Tracker")).toBeInTheDocument();
  expect(inv.locations(store.state).map((l) => l.name)).toEqual(["Cold locker", "Warm locker"]);
});

test("Enter in the new-name box adds it", async () => {
  await fixture();
  navigate("/settings/locations");
  mount();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("New location"), "Dry locker{Enter}");
  await waitFor(() =>
    expect(inv.locations(store.state).map((l) => l.name)).toEqual(["Cold locker", "Warm locker", "Dry locker"]),
  );
  expect(screen.getByLabelText("New location")).toHaveValue("");
});

test("deleting a location in use is refused and names the items", async () => {
  await fixture();
  navigate("/settings/locations");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Delete Cold locker" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("In use by Tent 1");
  expect(inv.locations(store.state)).toHaveLength(2);

  await user.click(screen.getByRole("button", { name: "Rename Warm locker" }));
  await user.clear(screen.getByLabelText("New name for Warm locker"));
  await user.type(screen.getByLabelText("New name for Warm locker"), "Dry locker");
  await user.click(screen.getByRole("button", { name: "Save Warm locker" }));
  await waitFor(() => expect(inv.locations(store.state).map((l) => l.name)).toEqual(["Cold locker", "Dry locker"]));
});

test("an Admin adds a category in Settings and it appears (FR-SET-07)", async () => {
  await fixture();
  navigate("/settings/categories");
  mount();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("New category"), "Camp kitchen{Enter}");
  await waitFor(() => expect(inv.categories(store.state).map((c) => c.name)).toEqual(["Camp kitchen"]));
  expect(screen.getByLabelText("New category")).toHaveValue("");
});

test("deleting a category in use is refused and names the item (FR-SET-07, FR-SET-05)", async () => {
  const f = await fixture();
  const camp = await act.createCategory(store, "Camp kitchen");
  await act.updateItem(store, f.stove, { category_ids: [camp] });
  navigate("/settings/categories");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Delete Camp kitchen" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("In use by Stove");
  expect(inv.categories(store.state)).toHaveLength(1);
});

test("a group name that arrives after the settings page opens fills the form", async () => {
  navigate("/settings/group");
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
  // The group name says whose copy this is, in the tab and under the home-screen icon.
  await waitFor(() => expect(document.title).toBe("10th Richmond Sea Scouts · Gear Tracker"));
});

test("the overdue period is one group setting; blank means never (FR-OUT-14)", async () => {
  navigate("/settings/group");
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

test("the menu reaches every section, users included", async () => {
  await fixture();
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Menu" }));
  const sections = within(screen.getByRole("navigation", { name: "Menu" })).getAllByRole("button");
  expect(sections.map((b) => b.textContent)).toEqual([
    "Home",
    "All items",
    "Reports",
    "Reservations",
    "Stock check",
    "Users",
    "Settings",
    "Help",
    "Sign out",
  ]);

  await user.click(screen.getByRole("button", { name: "Users" }));
  expect(location.pathname).toBe("/settings/users");

  reactAct(() => navigate("/"));
  await user.click(screen.getByRole("button", { name: "Menu" }));
  await user.click(screen.getByRole("button", { name: "All items" }));
  expect(location.pathname).toBe("/items");
});

test("the menu opens from any screen, not only Home, and lists Home first", async () => {
  await fixture();
  navigate("/repairs");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Menu" }));
  const sections = within(screen.getByRole("navigation", { name: "Menu" })).getAllByRole("button");
  expect(sections[0]!.textContent).toBe("Home");

  await user.click(screen.getByRole("button", { name: "Home" }));
  expect(location.pathname).toBe("/");
  // The link landed with the menu closed, not still open over the home screen.
  expect(screen.queryByRole("navigation", { name: "Menu" })).not.toBeInTheDocument();
});

test("the title is a link home, on every screen", async () => {
  await fixture();
  navigate("/repairs");
  mount();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Needs repair");
  await userEvent.setup().click(screen.getByRole("button", { name: "Needs repair" }));
  expect(location.pathname).toBe("/");
});

test("the Locations pages are gone", async () => {
  await fixture();
  navigate("/locations");
  mount();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Not found");
  expect(screen.getByText("Nothing lives at /locations.")).toBeInTheDocument();
});

test("Sign out in the menu is blocked while records are unsent", async () => {
  // Offline sync leaves fixture()'s creations unsent.
  await fixture();
  mount();
  await userEvent.setup().click(screen.getByRole("button", { name: "Menu" }));
  expect(screen.getByRole("button", { name: "Sign out" })).toBeDisabled();
  expect(screen.getByText("Sign out after your unsent records are sent.")).toBeInTheDocument();
});

test("home is empty until something is asked of it", async () => {
  await fixture();
  mount();
  const user = userEvent.setup();
  const hint = "Check out or return gear by scanning its code. Search by name for gear with no sticker.";
  expect(screen.getByText(hint)).toBeInTheDocument();
  expect(screen.queryAllByRole("listitem")).toEqual([]);
  // No count, no sync line, no filters: the list is a fold away at /items.
  expect(screen.queryByText("2 items")).not.toBeInTheDocument();
  expect(screen.queryByText("Filters")).not.toBeInTheDocument();

  await user.type(screen.getByLabelText("Search"), "tent");
  expect(rows()).toEqual(["Tent 1Cold locker / shelf 4"]);
  expect(location.pathname + location.search).toBe("/?q=tent");

  await user.clear(screen.getByLabelText("Search"));
  expect(screen.getByText(hint)).toBeInTheDocument();
});

test("the search box sits in main, and the menu takes over the screen while open", async () => {
  await fixture();
  mount();
  const user = userEvent.setup();
  expect(within(screen.getByRole("main")).getByLabelText("Search")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Menu" }));
  const menu = within(screen.getByRole("navigation", { name: "Menu" }));
  expect(menu.getByRole("button", { name: "All items" })).toBeInTheDocument();
  expect(menu.getByRole("button", { name: "Reports" })).toBeInTheDocument();
  expect(menu.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  expect(menu.getByRole("button", { name: "Help" })).toBeInTheDocument();
  expect(menu.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Close menu" }));
  expect(screen.getByRole("button", { name: "Check out" })).toBeInTheDocument();
});

test("the phone's /items is the whole list, counted and filtered", async () => {
  await fixture();
  navigate("/items");
  mount();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Inventory");
  expect(screen.getByText("2 items")).toBeInTheDocument();
  expect(screen.getByText("Filters")).toBeInTheDocument();
  expect(rows()).toEqual(["StoveWarm locker", "Tent 1Cold locker / shelf 4"]);

  await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
  expect(location.pathname).toBe("/");
});

test("the phone list heads its rows by category once one exists, uncategorised last (FR-SET-07)", async () => {
  const f = await fixture();
  navigate("/items");
  mount();
  expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
  expect(rows()).toEqual(["StoveWarm locker", "Tent 1Cold locker / shelf 4"]);

  const camp = await act.createCategory(store, "Camp kitchen");
  await act.updateItem(store, f.stove, { category_ids: [camp] });
  await waitFor(() =>
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Camp kitchen",
      "No category",
    ]),
  );
  expect(rows()).toEqual(["StoveWarm locker", "Tent 1Cold locker / shelf 4"]);
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((h) => (h.closest("details") as HTMLDetailsElement).open),
  ).toEqual([true, true]);
});

test("a category heading folds its rows away (FR-SET-07)", async () => {
  const f = await fixture();
  const camp = await act.createCategory(store, "Camp kitchen");
  await act.updateItem(store, f.stove, { category_ids: [camp] });
  navigate("/items");
  mount();

  const heading = await screen.findByRole("heading", { name: "Camp kitchen" });
  const fold = heading.closest("details") as HTMLDetailsElement;
  expect(fold.open).toBe(true);

  await userEvent.setup().click(heading);
  expect(fold.open).toBe(false);
});

test("the Category filter and field appear only once a category exists, and the filter narrows the list (FR-SET-07)", async () => {
  const f = await fixture();
  navigate("/items");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByText("Filters"));
  expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();

  const camp = await act.createCategory(store, "Camp kitchen");
  await act.updateItem(store, f.stove, { category_ids: [camp] });
  await waitFor(() => expect(screen.getByLabelText("Category")).toBeInTheDocument());
  await user.selectOptions(screen.getByLabelText("Category"), camp);
  expect(rows()).toEqual(["StoveWarm locker"]);
});

test("a User has no Users link", async () => {
  await store.setMeta({ user: { id: "u2", name: "Bob", role: "user", active: true } });
  await fixture();
  mount();
  await userEvent.setup().click(screen.getByRole("button", { name: "Menu" }));
  const sections = within(screen.getByRole("navigation", { name: "Menu" })).getAllByRole("button");
  expect(sections.map((b) => b.textContent)).not.toContain("Users");
});

test("settings are for admins; others see their account only", async () => {
  await store.setMeta({ user: { id: "u2", name: "Bob", role: "user", active: true } });
  navigate("/settings");
  mount();
  expect(screen.getByText("Signed in as Bob")).toBeInTheDocument();
  expect(screen.queryByText("Locations")).not.toBeInTheDocument();
});

test("printing posts the sheet count with the bearer token, under the app's base, and opens the PDF", async () => {
  // The sheet is answered; sync, which shares the API, finds no server as usual.
  const calls: { url: string; init: RequestInit }[] = [];
  const recording: typeof fetch = async (input, init) => {
    if (!String(input).includes("/codes/sheets")) return offline();
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

  navigate("/settings/codes");
  mount(recording, "/gear");
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText("Sheets"));
  await user.type(screen.getByLabelText("Sheets"), "3");
  await user.click(within(screen.getByRole("main")).getByRole("button", { name: "Print codes" }));

  expect(await screen.findByRole("link", { name: "Download codes.pdf" })).toHaveAttribute("href", "blob:codes");
  expect(opened).toEqual(["blob:codes"]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("/gear/codes/sheets");
  expect(calls[0]!.init.method).toBe("POST");
  expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer t", "Content-Type": "application/json" });
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sheets: 3 });
});

test("a refused print shows the server's message", async () => {
  const refusing: typeof fetch = async (input) =>
    String(input).includes("/codes/sheets")
      ? new Response(JSON.stringify({ error: "forbidden", message: "admins only" }), { status: 403 })
      : offline();
  navigate("/settings/codes");
  mount(refusing);
  await userEvent.setup().click(within(screen.getByRole("main")).getByRole("button", { name: "Print codes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("admins only");
});

test("Help opened cold goes home on back, not to Settings (NFR-USE-11)", async () => {
  navigate("/help");
  mount();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Help");
  await userEvent.setup().click(screen.getByRole("button", { name: "Back" }));
  expect(location.pathname).toBe("/");
});

test("the guide is the compiled markdown, with contents that reach each task", async () => {
  navigate("/help");
  mount();
  // One heading per section, in the order the build lists them.
  const sections = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
  expect(sections.slice(0, 2)).toEqual(["Scouter", "Quartermaster"]);
  // The first task, and the contents link that jumps to it.
  expect(screen.getAllByRole("heading", { level: 3 })[0]).toHaveTextContent("Check gear out");
  const contents = within(screen.getByRole("navigation", { name: "Scouter contents" }));
  expect(contents.getByRole("link", { name: "Check gear out" })).toHaveAttribute("href", "#check-gear-out");
});

// --- Back follows the way in ------------------------------------------------

test("the list keeps its search in the URL, and back brings the list back as it was", async () => {
  const f = await fixture();
  mount();
  const user = userEvent.setup();

  await user.type(screen.getByLabelText("Search"), "shelf");
  expect(location.pathname + location.search).toBe("/?q=shelf");
  expect(rows()).toEqual(["Tent 1Cold locker / shelf 4"]);

  await user.click(screen.getByRole("button", { name: /Tent 1/ }));
  expect(location.pathname).toBe(`/items/${f.t1}`);

  // One step back, whatever was typed to get here.
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(location.pathname + location.search).toBe("/?q=shelf");
  expect(screen.getByLabelText("Search")).toHaveValue("shelf");
});

test("back from an item returns to the list it was opened from", async () => {
  const f = await fixture();
  navigate("/items");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Tent 1/ }));
  expect(location.pathname).toBe(`/items/${f.t1}`);

  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(location.pathname).toBe("/items");
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Inventory");
});

test("back from an item returns to the what-is-out report", async () => {
  const f = await fixture();
  await checkOut(store, f.t1, { event: "Spring camp" });
  navigate("/out");
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Tent 1/ }));
  expect(location.pathname).toBe(`/items/${f.t1}`);

  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(location.pathname).toBe("/out");
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("What is out");
});

test("the scanner walk: an unassigned code, a new item, and back to where it started", async () => {
  await fixture();
  await printCodes(store, ["ABCDEFGH23"]);
  mount();
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Check out" }));
  await user.click(await screen.findByRole("button", { name: "Type a code instead" }));
  await user.type(screen.getByLabelText("Code or URL"), "ABCDEFGH23");
  await user.click(screen.getByRole("button", { name: "Go" }));
  expect(location.pathname).toBe("/g/ABCDEFGH23");

  // The code screen is a junction, so it steps aside for the form.
  await user.click(await screen.findByRole("button", { name: "Create a new item" }));
  expect(location.pathname + location.search).toBe("/items/new?code=ABCDEFGH23");

  await user.type(screen.getByLabelText("Name"), "Tarp");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(location.pathname).toBe("/scan"));

  // And one step back from the scanner is home, not the code screen again.
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(location.pathname).toBe("/");
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Gear Tracker");
});

test("a replacement sticker: back from the item goes home, not through the scanner", async () => {
  const f = await fixture();
  await printCodes(store, ["ABCDEFGH23"]);
  mount();
  const user = userEvent.setup();

  await user.type(screen.getByLabelText("Search"), "Tent 1");
  await user.click(screen.getByRole("button", { name: /Tent 1/ }));
  await user.click(screen.getByRole("button", { name: "Add QR code" }));
  expect(location.pathname + location.search).toBe(`/scan?for=${f.t1}`);

  await user.click(await screen.findByRole("button", { name: "Type a code instead" }));
  await user.type(screen.getByLabelText("Code or URL"), "ABCDEFGH23");
  await user.click(screen.getByRole("button", { name: "Go" }));
  await waitFor(() => expect(location.pathname).toBe(`/items/${f.t1}`));
  expect(inv.currentCode(store.state, f.t1)?.id).toBe("ABCDEFGH23");

  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(location.pathname).toBe(`/items/${f.t1}`);
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(location.pathname).toBe("/");
});
