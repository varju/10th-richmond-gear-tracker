import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test, vi } from "vitest";
import { App } from "../App";
import * as act from "../lib/actions";
import { createApi, type ServerEvent } from "../lib/api";
import { DAY_MS } from "../lib/clock";
import { openDb } from "../lib/db";
import * as mv from "../lib/movement";
import { navigate } from "../lib/router";
import { Store } from "../lib/store";
import { desk } from "./widthTestKit";

// The desk's what-is-out (FR-RPT-01, NFR-USE-10), sortable by any column (FR-RPT-12).
const T0 = 1_756_684_800_000;
let store: Store;
let clock: number;

const offline = async (): Promise<Response> => {
  throw new TypeError("Failed to fetch");
};

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

beforeEach(async () => {
  clock = T0;
  navigate("/out");
  store = await Store.open(await openDb("out-table", new IDBFactory()), () => clock++);
  await store.setMeta({ token: "t", user: { id: "u1", name: "Alice", role: "admin", active: true }, cursor: 1 });
  await store.receive([joined("u1", "Alice"), joined("u2", "Carol")], 2);
  desk();
});

const user = userEvent.setup();

// The report's clock: items are created near T0, then checked out at points after it, so a full
// replay (should one run) still sees creation before check-out.
const NOW = T0 + 10 * DAY_MS;

/** Alice: Stove 2 days, Tent 1 5 days out (with an event). Carol: Axe 1 day out, and 4 of a pool. */
async function fixture() {
  const tent = await act.createItem(store, { name: "Tent 1" });
  const stove = await act.createItem(store, { name: "Stove" });
  const axe = await act.createItem(store, { name: "Axe" });
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);

  clock = T0 + 5 * DAY_MS;
  await mv.checkOut(store, tent, { event: "Spring camp" });
  clock = T0 + 8 * DAY_MS;
  await mv.checkOut(store, stove);

  await store.setMeta({ user: { id: "u2", name: "Carol", role: "user", active: true } });
  clock = T0 + 9 * DAY_MS;
  await mv.checkOut(store, axe);
  clock = T0 + 10 * DAY_MS;
  await mv.checkOutPool(store, bowls, { count: 4 });

  return { tent, stove, axe, bowls };
}

// Old, unsynced check-outs would otherwise raise the "unsent records" interrupt (STALE_PENDING_MS);
// this report is not what that screen is testing.
async function mount() {
  render(<App store={store} api={createApi({ fetch: offline, token: () => store.meta.token })} now={() => NOW} />);
  const dismiss = screen.queryByRole("button", { name: "Continue anyway" });
  if (dismiss) await user.click(dismiss);
}

const rows = () => within(screen.getByRole("table")).getAllByRole("row");
const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((c) => c.textContent);

test("the table's four columns, and the holder-ascending default", async () => {
  await fixture();
  await mount();

  expect(
    within(rows()[0]!)
      .getAllByRole("columnheader")
      .map((h) => h.textContent),
  ).toEqual(["Item", "Holder ▲", "Reservation", "Out"]);

  const body = rows().slice(1);
  // Holder ascending, longest out first within a holder, as the phone's grouped list already reads:
  // Alice's Tent 1, Stove; then Carol's Axe, Bowls (a pool has no day count, so it lands last).
  expect(body.map((r) => cells(r)[0])).toEqual(["Tent 1", "Stove", "Axe", "Bowls"]);
  expect(cells(body[0]!)).toEqual(["Tent 1", "Alice", "Spring camp", "5 days"]);
  expect(cells(body[3]!)).toEqual(["Bowls", "Carol", "", "4 out"]);
});

test("clicking Out opens longest out first, and clicking again turns it around (FR-RPT-12)", async () => {
  await fixture();
  await mount();

  // Time reads longest-first on the first click, the same way the phone's "Time out" reads it.
  await user.click(screen.getByRole("button", { name: "Out" }));
  expect(location.pathname + location.search).toBe("/out?sort=days&dir=down");
  expect(screen.getByRole("columnheader", { name: /Out/ })).toHaveAttribute("aria-sort", "descending");
  expect(
    rows()
      .slice(1)
      .map((r) => cells(r)[0]),
  ).toEqual(["Tent 1", "Stove", "Axe", "Bowls"]);

  await user.click(screen.getByRole("button", { name: /^Out/ }));
  expect(location.pathname + location.search).toBe("/out?sort=days");
  expect(screen.getByRole("columnheader", { name: /Out/ })).toHaveAttribute("aria-sort", "ascending");
  const body = rows().slice(1);
  expect(body.map((r) => cells(r)[0])).toEqual(["Bowls", "Axe", "Stove", "Tent 1"]);
  expect(cells(body[0]!)[3]).toBe("4 out");
});

test("a pool out to two people gets a row each (FR-RPT-11)", async () => {
  const { bowls } = await fixture();
  clock = T0 + 10 * DAY_MS;
  await store.setMeta({ user: { id: "u1", name: "Alice", role: "admin", active: true } });
  await mv.checkOutPool(store, bowls, { count: 2 });
  await mount();

  // One item, two holders, so the item id alone cannot key the rows.
  const bowlRows = rows()
    .slice(1)
    .filter((r) => cells(r)[0] === "Bowls");
  expect(bowlRows.map((r) => [cells(r)[1], cells(r)[3]])).toEqual([
    ["Alice", "2 out"],
    ["Carol", "4 out"],
  ]);
});

test("clicking the default column twice returns to ascending, clearing dir from the URL", async () => {
  await fixture();
  await mount();

  await user.click(screen.getByRole("button", { name: /^Holder/ }));
  expect(location.pathname + location.search).toBe("/out?dir=down");
  expect(screen.getByRole("columnheader", { name: /Holder/ })).toHaveAttribute("aria-sort", "descending");

  await user.click(screen.getByRole("button", { name: /^Holder/ }));
  expect(location.pathname).toBe("/out");
  expect(location.search).toBe("");
  expect(screen.getByRole("columnheader", { name: /Holder/ })).toHaveAttribute("aria-sort", "ascending");
});

test("no duplicate React keys when one pool is out to two people", async () => {
  const { bowls } = await fixture();
  clock = T0 + 10 * DAY_MS;
  await store.setMeta({ user: { id: "u1", name: "Alice", role: "admin", active: true } });
  await mv.checkOutPool(store, bowls, { count: 2 });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  await mount();
  const complaints = err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("same key"));
  err.mockRestore();
  expect(complaints).toEqual([]);
});
