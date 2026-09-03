import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { DAY_MS } from "../lib/clock";
import * as mv from "../lib/movement";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { type Shell, ShellContext } from "../shell";
import { openStore } from "./codeTestKit";
import { Home } from "./Home";
import { alice, carol, seedUsers } from "./moveTestKit";
import { Report } from "./Report";

// What is out, and who has it (FR-RPT-01), with gear out too long flagged (FR-OUT-14, FR-RPT-05).
const T0 = 1_756_684_800_000;
let store: Store;
let tent: string;
let stove: string;
let axe: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice, carol]);
  const cold = await act.createLocation(store, "Cold locker");
  tent = await act.createItem(store, { name: "Tent 1", home_location_id: cold, sub_location: "shelf 4" });
  stove = await act.createItem(store, { name: "Stove", home_location_id: cold });
  axe = await act.createItem(store, { name: "Axe" });
  navigate("/out");
});

const user = userEvent.setup();

/** The group setting as the server would deliver it, without going through the settings form. */
const setGroup = (payload: Record<string, unknown>) =>
  store.record({ entity_type: "setting", entity_id: "group", type: "created", actor_id: "alice", payload });

/** The store's clock sits at T0; the screen's clock is `daysLater` after it. */
function mount(node: React.ReactNode, daysLater = 0) {
  const shell: Shell = {
    busy: false,
    outcome: null,
    // A second of slack: the store stamps each event a millisecond after T0.
    now: () => T0 + daysLater * DAY_MS + 1000,
    sync: async () => undefined,
    signOut: async () => {},
  };
  return render(<ShellContext value={shell}>{node}</ShellContext>);
}

const holder = (name: string) => screen.getByRole("region", { name });
const rows = (name: string) => within(holder(name)).getAllByRole("button");

test("nothing out says so", async () => {
  mount(<Report store={store} />);
  expect(screen.getByRole("heading", { name: "What is out" })).toBeInTheDocument();
  expect(screen.getByText("Nothing is out.")).toBeInTheDocument();
});

test("out gear is grouped by holder with the event and days out", async () => {
  await setGroup({ name: "10th Richmond" });
  await mv.checkOut(store, tent, { event: "Spring camp" });
  await mv.checkOut(store, stove);
  await store.setMeta({ user: carol });
  await mv.checkOut(store, axe);

  mount(<Report store={store} />, 3);
  expect(screen.getByText("10th Richmond · 2025-09-04")).toBeInTheDocument();
  expect(screen.getByText("3 items out")).toBeInTheDocument();

  expect(screen.getAllByRole("region").map((s) => s.getAttribute("aria-label"))).toEqual(["Alice", "Carol"]);
  // Same day out: alphabetical.
  expect(rows("Alice").map((b) => b.textContent)).toEqual(["Stoveout 3 days", "Tent 1Spring camp · out 3 days"]);
  expect(rows("Carol")[0]).toHaveTextContent("Axe");
  expect(rows("Carol")[0]).toHaveTextContent("out 3 days");
  expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
});

test("a check-out today reads as today", async () => {
  await mv.checkOut(store, axe);
  mount(<Report store={store} />);
  expect(rows("Alice")[0]).toHaveTextContent("out today");
});

test("gear out longer than the group's period is flagged and counted", async () => {
  await setGroup({ name: "10th Richmond", overdue_days: 30 });
  await mv.checkOut(store, tent);
  await mv.checkOut(store, stove);

  mount(<Report store={store} />, 29);
  expect(screen.getByText("2 items out")).toBeInTheDocument();
  expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
});

test("the overdue flag appears once the period has passed", async () => {
  await setGroup({ name: "10th Richmond", overdue_days: 30 });
  await mv.checkOut(store, tent);

  mount(<Report store={store} />, 40);
  expect(screen.getByText("1 item out · 1 overdue")).toBeInTheDocument();
  const row = rows("Alice")[0]!;
  expect(row).toHaveTextContent("Tent 1");
  expect(within(row).getByText("Overdue")).toHaveClass("badge", "overdue");
  expect(row).toHaveTextContent("out 40 days");
});

test("a row opens the item", async () => {
  await mv.checkOut(store, tent);
  mount(<Report store={store} />);
  await user.click(rows("Alice")[0]!);
  expect(location.pathname).toBe(`/items/${tent}`);
});

test("the home screen always links to the report, and counts what is out", async () => {
  navigate("/");
  const first = mount(<Home store={store} />);
  expect(screen.getByRole("button", { name: "What is out" })).toBeInTheDocument();
  first.unmount();

  await mv.checkOut(store, tent);
  await mv.checkOut(store, axe);
  mount(<Home store={store} />);
  await user.click(screen.getByRole("button", { name: "What is out · 2" }));
  expect(location.pathname).toBe("/out");
});
