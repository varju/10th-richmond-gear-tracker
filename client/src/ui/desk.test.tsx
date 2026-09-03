import { act as reactAct, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import { App } from "../App";
import * as act from "../lib/actions";
import { createApi, type ServerEvent } from "../lib/api";
import { DAY_MS } from "../lib/clock";
import { openDb } from "../lib/db";
import { checkOut } from "../lib/movement";
import * as rep from "../lib/repairs";
import { createReservation, todayIso } from "../lib/reservations";
import { navigate } from "../lib/router";
import { Store } from "../lib/store";
import { localDate } from "../lib/time";
import { desk, PHONE, setWidth } from "./widthTestKit";

// The desk layout (NFR-USE-10): a sidebar, a home that opens on exceptions,
// and the inventory as a table. The phone layout is the same components at a
// phone width, and must not change.
const T0 = 1_756_684_800_000;
let store: Store;
let clock: number;

const offline = async (): Promise<Response> => {
  throw new TypeError("Failed to fetch");
};

beforeEach(async () => {
  clock = T0;
  navigate("/");
  store = await Store.open(await openDb("desk", new IDBFactory()), () => clock++);
  await store.setMeta({ token: "t", user: { id: "u1", name: "Alice", role: "admin", active: true }, cursor: 1 });
  desk();
});

async function fixture() {
  const cold = await act.createLocation(store, "Cold locker");
  const tent = await act.createItem(store, { name: "Tent 1", home_location_id: cold, sub_location: "shelf 4" });
  const stove = await act.createItem(store, { name: "Stove", home_location_id: cold });
  const tarp = await act.createGeneric(store, { name: "3x3 tarp", home_location_id: cold });
  const first = await act.addUnit(store, tarp);
  await act.addUnit(store, tarp);
  return { cold, tent, stove, tarp, first };
}

/** Users arrive from the server like everything else; the report names the holder from state. */
function joined(id: string, name: string): ServerEvent {
  return {
    id: `0100000000000000000000user${id}`.slice(-26),
    entity_type: "user",
    entity_id: id,
    type: "created",
    actor_id: "server",
    device_id: "server",
    device_seq: 1,
    occurred_at: T0,
    clock_offset: 0,
    effective_at: T0,
    received_at: T0,
    seq: 1,
    payload: { name, role: "admin", active: true },
  };
}

function found(id: string, note: string, item_id: string): ServerEvent {
  return {
    id,
    entity_type: "found_report",
    entity_id: id,
    type: "created",
    actor_id: "public",
    device_id: "server",
    device_seq: 1,
    occurred_at: T0,
    clock_offset: 0,
    effective_at: T0,
    received_at: T0,
    seq: 1,
    payload: { code: "BBBBBBBBBB", item_id, note, contact: "" },
  };
}

const mount = (now = T0) =>
  render(<App store={store} api={createApi({ fetch: offline, token: () => store.meta.token })} now={() => now} />);

const sidebar = () => within(screen.getByRole("navigation", { name: "Sections" })).getAllByRole("button");
const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((c) => c.textContent);

test("the sidebar carries every section, with Help at its foot", async () => {
  await fixture();
  mount();
  expect(sidebar().map((b) => b.textContent)).toEqual([
    "Inventory · 4",
    "What is out",
    "Needs repair",
    "Reservations · 0 upcoming",
    "Browse by location",
    "Stock check",
    "Users",
    "Settings",
    "Help",
  ]);

  await userEvent.setup().click(screen.getByRole("button", { name: "Inventory · 4" }));
  expect(location.pathname).toBe("/items");
  // Every desk screen keeps the sections beside it.
  expect(sidebar()).not.toHaveLength(0);
});

test("alerts join the sidebar only when something is wrong", async () => {
  const f = await fixture();
  mount();
  expect(sidebar().map((b) => b.textContent)).not.toContain("Found gear · 1");

  await store.receive([found("01000000000000000000000001", "by the gate", f.tent)], 2);
  expect(sidebar().map((b) => b.textContent)[0]).toBe("Found gear · 1");
});

test("the desk home opens on what needs a person, then what is out", async () => {
  const f = await fixture();
  await rep.raiseTicket(store, f.stove, "handle bent");
  await checkOut(store, f.tent, { event: "Spring camp" });
  await store.receive([joined("u1", "Alice"), found("01000000000000000000000001", "by the gate", f.tent)], 2);
  mount();

  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Gear Tracker");
  const attention = within(screen.getByRole("list", { name: "Needs attention" })).getAllByRole("button");
  expect(attention.map((b) => b.textContent)).toEqual([
    "Found gear · 1",
    "Needs repair · 1",
    // Nothing is overdue: the group has set no period (FR-OUT-14).
    `Unsent records · ${store.pending.length}`,
  ]);

  // What is out, inline, with the holder and the event (FR-RPT-01).
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(
    within(rows[0]!)
      .getAllByRole("columnheader")
      .map((h) => h.textContent),
  ).toEqual(["Item", "Holder", "Event", "Out"]);
  expect(cells(rows[1]!)).toEqual(["Tent 1", "Alice", "Spring camp", "today"]);
});

test("with nothing wrong the desk home says so", async () => {
  await fixture();
  await store.setMeta({ cursor: 1 });
  // Pretend this device has sent everything it has.
  await store.receive([], 1);
  mount();
  expect(screen.getByText("Nothing is out.")).toBeInTheDocument();
  expect(screen.getByText(/Nothing in the next \d+ days/)).toBeInTheDocument();
});

test("gear out past the group's period is counted as overdue (FR-OUT-14)", async () => {
  const f = await fixture();
  await act.setGroup(store, { overdue_days: 1 });
  await checkOut(store, f.tent);
  // A minute past a whole day, because the check-out is a moment after T0.
  mount(T0 + DAY_MS + 60_000);
  expect(screen.getByRole("button", { name: "Overdue · 1" })).toBeInTheDocument();
  expect(within(screen.getByRole("table")).getByText("1 day")).toBeInTheDocument();
});

test("a reservation in the next few weeks is coming up", async () => {
  await fixture();
  const soon = localDate(T0 + 7 * DAY_MS);
  await createReservation(store, { event: "Spring camp", starts: soon, ends: soon, items: [], generics: [] });
  await createReservation(store, {
    event: "Summer camp",
    starts: localDate(T0 + 200 * DAY_MS),
    ends: localDate(T0 + 201 * DAY_MS),
    items: [],
    generics: [],
  });
  mount();
  expect(screen.getByRole("button", { name: /Spring camp/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Summer camp/ })).not.toBeInTheDocument();
  expect(todayIso(T0)).toBe(localDate(T0));
});

test("the inventory is a table, sortable, its units always shown under their generic", async () => {
  await fixture();
  navigate("/items");
  mount();
  const user = userEvent.setup();

  // The name is the only button in a row.
  const names = () =>
    within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("button").at(-1)!.textContent);
  // A generic's units sit under it with no click needed (FR-INV-25).
  expect(names()).toEqual(["3x3 tarp", "3x3 tarp #1", "3x3 tarp #2", "Stove", "Tent 1"]);
  expect(screen.getByText("2 units · 2 in")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Units of/ })).not.toBeInTheDocument();

  // The same header again turns the sort around.
  await user.click(screen.getByRole("button", { name: /^Name/ }));
  expect(names()).toEqual(["Tent 1", "Stove", "3x3 tarp", "3x3 tarp #1", "3x3 tarp #2"]);
  expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "descending");

  await user.click(screen.getByRole("button", { name: /^Home/ }));
  expect(screen.getByRole("columnheader", { name: /Home/ })).toHaveAttribute("aria-sort", "ascending");
});

test("a Category column appears once one exists, and sorts (FR-SET-07)", async () => {
  const f = await fixture();
  const camp = await act.createCategory(store, "Camp kitchen");
  const shelter = await act.createCategory(store, "Shelter");
  await act.updateItem(store, f.stove, { category_ids: [camp] });
  await act.updateItem(store, f.tent, { category_ids: [shelter] });
  navigate("/items");
  mount();
  const user = userEvent.setup();

  expect(screen.getByRole("columnheader", { name: /^Category/ })).toBeInTheDocument();
  const category = (rowName: string) => {
    const row = within(screen.getByRole("table"))
      .getAllByRole("row")
      .find((r) => within(r).queryByRole("button", { name: rowName }));
    return cells(row!)[1];
  };
  expect(category("Stove")).toBe("Camp kitchen");
  expect(category("Tent 1")).toBe("Shelter");
  expect(category("3x3 tarp")).toBe("");

  await user.click(screen.getByRole("button", { name: /^Category/ }));
  const names = () =>
    within(screen.getByRole("table"))
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("button").at(-1)!.textContent);
  // Ascending: the uncategorised generic and its units sort first, then by category name.
  expect(names()).toEqual(["3x3 tarp", "3x3 tarp #1", "3x3 tarp #2", "Stove", "Tent 1"]);
});

test("the table narrows by search and by filter", async () => {
  await fixture();
  navigate("/items");
  mount();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Search"), "stove");
  expect(screen.getByText("1 row")).toBeInTheDocument();

  await user.clear(screen.getByLabelText("Search"));
  await user.selectOptions(screen.getByLabelText("Status"), "out");
  expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
});

test("no camera, no Scan button", async () => {
  await fixture();
  navigate("/items");
  mount();
  expect(screen.getByRole("button", { name: "New item" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Scan" })).not.toBeInTheDocument();
});

test("an item page puts its facts beside its history", async () => {
  const f = await fixture();
  navigate(`/items/${f.tent}`);
  mount();
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Tent 1");
  const columns = document.querySelectorAll(".two-col > div");
  expect(columns).toHaveLength(2);
  expect(columns[0]!).toHaveTextContent("Cold locker / shelf 4");
  expect(columns[1]!).toHaveTextContent("History");
});

test("a phone keeps the list at /items, and has no sidebar", async () => {
  await fixture();
  setWidth(PHONE);
  mount();
  // Home holds the sections behind the menu, not a sidebar, and shows no list until asked.
  expect(screen.queryByRole("navigation", { name: "Sections" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Tent 1/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();

  reactAct(() => navigate("/items"));
  expect(screen.getByRole("button", { name: /Tent 1/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Scan" })).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

test("the table's search, filter and sort live in the URL, and back brings them back", async () => {
  const f = await fixture();
  navigate("/items");
  mount();
  const user = userEvent.setup();

  await user.type(screen.getByLabelText("Search"), "t");
  await user.click(screen.getByRole("button", { name: /^Home/ }));
  await user.click(screen.getByRole("button", { name: /^Home/ }));
  await user.selectOptions(screen.getByLabelText("Location"), f.cold);
  expect(location.pathname + location.search).toBe(`/items?q=t&location=${f.cold}&sort=home&dir=down`);

  await user.click(screen.getByRole("button", { name: "Tent 1" }));
  expect(location.pathname).toBe(`/items/${f.tent}`);

  // One step back, however many keystrokes went into the search.
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(location.pathname + location.search).toBe(`/items?q=t&location=${f.cold}&sort=home&dir=down`);
  expect(screen.getByLabelText("Search")).toHaveValue("t");
  expect(screen.getByLabelText("Location")).toHaveValue(f.cold);
  expect(screen.getByRole("columnheader", { name: /Home/ })).toHaveAttribute("aria-sort", "descending");
});

test("the desk home ignores list parameters meant for the table", async () => {
  await fixture();
  navigate("/?q=nothing-matches-this");
  mount();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Gear Tracker");
  expect(screen.getByText("Nothing is out.")).toBeInTheDocument();
});
