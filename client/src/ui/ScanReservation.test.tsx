import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { item } from "../lib/inventory";
import * as mv from "../lib/movement";
import * as res from "../lib/reservations";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore, printCodes } from "./codeTestKit";
import { alice, renderInShell, seedUsers } from "./moveTestKit";
import { Scan } from "./Scan";

// Packing for a camp: the session seeded with the reservation (S-RES-02, S-RES-03, S-RES-04).
let store: Store;
let tent: string;
let tent2: string;
let tarp: string;
let stove: string;
let fall: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
  await printCodes(store, ["AAAAAAAAAA", "BBBBBBBBBB"]);
  const cold = await act.createLocation(store, "Cold locker");
  const warm = await act.createLocation(store, "Warm locker");
  const tents = await act.createGeneric(store, { name: "4-person tent", home_location_id: cold });
  tent = await act.addUnit(store, tents);
  tent2 = await act.addUnit(store, tents);
  tarp = await act.createItem(store, { name: "Tarp", home_location_id: warm });
  stove = await act.createItem(store, { name: "Stove", home_location_id: warm });
  await act.bindCode(store, "AAAAAAAAAA", tent);
  await act.bindCode(store, "BBBBBBBBBB", stove);
  fall = await res.createReservation(store, {
    event: "Fall Camp",
    starts: "2026-10-02",
    ends: "2026-10-04",
    items: [tarp, tent],
    generics: [{ item_id: tents, quantity: 1 }],
  });
  // The way in: the reservation's page, then its packing session.
  navigate(`/reservations/${fall}`);
  navigate(`/scan?reservation=${fall}`);
});

afterEach(() => unsaved.cancel());

const user = userEvent.setup();
const remaining = () => screen.getByRole("region", { name: "Remaining" });
const rows = () => within(remaining()).queryAllByRole("button");

async function typeCode(text: string) {
  const open = screen.queryByRole("button", { name: "Type a code instead" });
  if (open) await user.click(open);
  await user.type(screen.getByLabelText("Code or URL"), text);
  await user.click(screen.getByRole("button", { name: "Go" }));
}

test("the session takes the event from the reservation and lists what is left, by home (FR-RES-02, FR-RES-03)", async () => {
  await store.setMeta({ session_event: "Something else" });
  renderInShell(<Scan store={store} />);
  expect(await screen.findByText("Event: Fall Camp")).toBeInTheDocument();
  expect(store.meta.session_event).toBe("Fall Camp");
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Pack");

  expect(rows().map((b) => b.textContent)).toEqual(["4-person tent #1Cold locker", "TarpWarm locker"]);
  expect(remaining()).toHaveTextContent("0 of 1 × 4-person tent");
});

test("a scan ticks an item off; an unlisted one is appended with no fuss (FR-RES-07)", async () => {
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(screen.getByRole("button", { name: "Check out" }));
  await screen.findByText("Checked out · 4-person tent #1");
  expect(rows().map((b) => b.textContent)).toEqual(["TarpWarm locker"]);
  expect(item(store.state, tent)?.movement?.event).toBe("Fall Camp");

  await typeCode("BBBBBBBBBB");
  await user.click(screen.getByRole("button", { name: "Check out" }));
  await screen.findByText("Checked out · Stove");
  expect(item(store.state, stove)).toMatchObject({ status: "out", holder_id: "alice" });
  expect(rows().map((b) => b.textContent)).toEqual(["TarpWarm locker"]);

  // The stove was not on the list. It joins it, and shows as ticked (S-RES-04).
  await waitFor(() => expect(res.reservation(store.state, fall)?.items).toEqual([tarp, tent, stove]));
  expect(store.pending.at(-1)).toMatchObject({ type: "item_added", entity_id: fall, payload: { item_id: stove } });
  expect(remaining()).toHaveTextContent("✓ Stove");
});

test("a unit that overflows a full generic line raises the line instead (FR-RES-07)", async () => {
  const tents = item(store.state, tent)!.parent_id!;
  const tent3 = await act.addUnit(store, tents);
  renderInShell(<Scan store={store} />);

  // One tent fills the line that was asked for; the list does not grow.
  await mv.checkOut(store, tent2, { event: "Fall Camp" });
  await res.addExtra(store, fall, tent2);
  await waitFor(() => expect(remaining()).toHaveTextContent("1 of 1 × 4-person tent"));
  expect(res.reservation(store.state, fall)?.generics).toEqual([{ item_id: tents, quantity: 1 }]);

  await mv.checkOut(store, tent3, { event: "Fall Camp" });
  await res.addExtra(store, fall, tent3);
  await waitFor(() => expect(remaining()).toHaveTextContent("2 of 2 × 4-person tent"));
  expect(res.reservation(store.state, fall)?.items).toEqual([tarp, tent]);
});

test("gear with no sticker is ticked off from the list itself (FR-OUT-02)", async () => {
  renderInShell(<Scan store={store} />);
  await user.click(within(remaining()).getByRole("button", { name: /Tarp/ }));
  expect(await screen.findByText("Checked out · Tarp")).toHaveAttribute("role", "status");
  expect(item(store.state, tarp)).toMatchObject({
    status: "out",
    movement: expect.objectContaining({ event: "Fall Camp" }),
  });
  expect(rows().map((b) => b.textContent)).toEqual(["4-person tent #1Cold locker"]);
});

test("checking an item off the list silences its bound code", async () => {
  renderInShell(<Scan store={store} />);
  await user.click(within(remaining()).getByRole("button", { name: /4-person tent #1/ }));
  expect(await screen.findByText("Checked out · 4-person tent #1")).toHaveAttribute("role", "status");
  await typeCode("AAAAAAAAAA");
  expect(screen.queryByRole("region", { name: "4-person tent #1" })).not.toBeInTheDocument();
});

test("any unit of a reserved generic counts toward it", async () => {
  renderInShell(<Scan store={store} />);
  await mv.checkOut(store, tent2, { event: "Fall Camp" });
  await waitFor(() => expect(remaining()).toHaveTextContent("1 of 1 × 4-person tent"));
});

test("Finish with items unscanned names them; Finish anyway leaves (FR-RES-04)", async () => {
  renderInShell(<Scan store={store} />);
  await user.click(screen.getByRole("button", { name: "Finish" }));
  const ask = screen.getByRole("group", { name: "Finish" });
  expect(within(ask).getByRole("alert")).toHaveTextContent("Not scanned: 4-person tent #1, Tarp, 1 × 4-person tent.");

  await user.click(within(ask).getByRole("button", { name: "Keep packing" }));
  expect(screen.queryByRole("group", { name: "Finish" })).not.toBeInTheDocument();
  expect(location.pathname).toBe("/scan");

  await user.click(screen.getByRole("button", { name: "Finish" }));
  await user.click(screen.getByRole("button", { name: "Finish anyway" }));
  expect(location.pathname).toBe(`/reservations/${fall}`);
});

test("with everything packed, Finish just leaves", async () => {
  await mv.checkOut(store, tent, { event: "Fall Camp" });
  await mv.checkOut(store, tarp, { event: "Fall Camp" });
  await mv.checkOut(store, tent2, { event: "Fall Camp" });
  renderInShell(<Scan store={store} />);
  expect(remaining()).toHaveTextContent("Everything is packed.");
  await user.click(screen.getByRole("button", { name: "Finish" }));
  expect(location.pathname).toBe(`/reservations/${fall}`);
});
