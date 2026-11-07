import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { describeValue } from "../lib/audit";
import * as inv from "../lib/inventory";
import { filterParams, readFilter } from "../lib/listUrl";
import { checkIn, checkOut } from "../lib/movement";
import { whatIsOut } from "../lib/reports";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore, printCodes } from "./codeTestKit";
import { FilterFields } from "./Filters";
import { HomeFields } from "./ItemFields";
import { ItemPage } from "./ItemPage";
import { alice, carol, renderInShell, seedUsers } from "./moveTestKit";
import { fakeCamera, stopFakeCamera } from "./scanTestKit";
import { Scan } from "./Scan";

// A person as an item's home (FR-INV-59, FR-INV-60, FR-INV-61).
const sam = { id: "sam", name: "Sam", role: "user", active: true };
let store: Store;
let cold: string;
let pole: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice, carol, sam]);
  cold = await act.createLocation(store, "Cold locker");
  pole = await act.createItem(store, { name: "Flagpole", home_user_id: "sam" });
});

afterEach(() => {
  stopFakeCamera();
  unsaved.cancel();
  cleanup();
  vi.restoreAllMocks();
});

const user = userEvent.setup();

/** The server says Sam was made inactive. */
const deactivate = () =>
  store.receive(
    [
      {
        id: "02000000000000000000009999",
        entity_type: "user",
        entity_id: "sam",
        type: "field_changed",
        actor_id: "server",
        device_id: "server",
        device_seq: 9999,
        occurred_at: 1,
        clock_offset: 0,
        effective_at: Date.now(),
        received_at: Date.now(),
        seq: 9999,
        payload: { field: "active", value: false, old: true },
      },
    ],
    9999,
  );

test("a person home reads as Kept by, and says inactive once the person is", async () => {
  expect(inv.homeLabel(store.state, inv.item(store.state, pole)!)).toBe("Kept by Sam");
  await deactivate();
  expect(inv.homeLabel(store.state, inv.item(store.state, pole)!)).toBe("Kept by Sam (inactive)");
  expect(inv.putBack(store.state, inv.item(store.state, pole)!)).toBe("Back with Sam (inactive)");
});

test("gear at its person home is in: not on What is out, and never overdue", async () => {
  await act.setGroup(store, { overdue_days: 1 });
  expect(inv.item(store.state, pole)?.status).toBe("in");
  expect(whatIsOut(store.state, Date.now() + 90 * 86_400_000).total).toBe(0);
});

test("taking it out is a normal check-out, and check-in returns it to the person", async () => {
  await checkOut(store, pole, { event: "Camp" });
  expect(whatIsOut(store.state, Date.now()).total).toBe(1);
  await checkIn(store, pole);
  expect(whatIsOut(store.state, Date.now()).total).toBe(0);
  expect(inv.homeLabel(store.state, inv.item(store.state, pole)!)).toBe("Kept by Sam");
});

test("setting a person clears the location and the shelf; setting a location clears the person", async () => {
  const tent = await act.createItem(store, { name: "Tent", home_location_id: cold, sub_location: "shelf 4" });
  await act.updateItem(store, tent, { home_user_id: "sam", home_location_id: null, sub_location: "" });
  expect(inv.item(store.state, tent)).toMatchObject({
    home_user_id: "sam",
    home_location_id: null,
    sub_location: null,
  });
  await act.updateItem(store, tent, { home_location_id: cold, home_user_id: null });
  expect(inv.item(store.state, tent)).toMatchObject({ home_user_id: null, home_location_id: cold });
});

test("the Home filter narrows to a person, and the person is in the URL", async () => {
  const tent = await act.createItem(store, { name: "Tent", home_location_id: cold });
  expect(inv.search(store.state, { home_user_id: "sam" }).map((i) => i.id)).toEqual([pole]);
  expect(inv.search(store.state, { location_id: cold }).map((i) => i.id)).toEqual([tent]);
  expect(inv.search(store.state, { needs: "location" })).toEqual([]);
  const filter = { home_user_id: "sam" };
  expect(readFilter(filterParams("", filter))).toMatchObject(filter);
  expect(inv.isNarrowing(filter)).toBe(true);
});

test("a new unit takes its generic's person home", async () => {
  const generic = await act.createGeneric(store, { name: "Badge box", home_user_id: "sam" });
  const unit = await act.addUnit(store, generic);
  expect(inv.item(store.state, unit)).toMatchObject({ home_user_id: "sam" });
  const single = await act.makeSingle(store, generic);
  expect(inv.item(store.state, single)).toMatchObject({ home_user_id: "sam" });
});

test("a unit's own person home survives making a generic with one unit single", async () => {
  const generic = await act.createGeneric(store, { name: "Badge box", home_location_id: cold });
  const unit = await act.createUnit(store, { parent_id: generic, number: "1", home_user_id: "sam" });
  await act.makeSingle(store, generic);
  expect(inv.item(store.state, unit)).toMatchObject({ home_user_id: "sam" });
});

test("the audit log shows a person home by name", () => {
  expect(describeValue(store.state, "home_user_id", "sam")).toBe("Sam");
});

test("the home field offers people under Kept by; picking one hides the shelf", async () => {
  const onChange = vi.fn();
  render(<HomeFields store={store} home_location_id={cold} sub_location="shelf 4" onChange={onChange} />);
  const select = screen.getByLabelText("Home location");
  expect(within(select).getByRole("group", { name: "Kept by" })).toBeInTheDocument();
  await user.selectOptions(select, "Sam");
  expect(onChange).toHaveBeenLastCalledWith({ home_user_id: "sam", home_location_id: null, sub_location: "" });
  await user.selectOptions(select, "Cold locker");
  expect(onChange).toHaveBeenLastCalledWith({ home_location_id: cold, home_user_id: null });
});

test("with a person home the shelf is hidden and the person is selected", () => {
  render(<HomeFields store={store} home_location_id={null} home_user_id="sam" sub_location="" onChange={() => {}} />);
  expect(screen.getByLabelText("Home location")).toHaveValue("user:sam");
  expect(screen.queryByLabelText("Shelf")).not.toBeInTheDocument();
});

test("an inactive keeper stays selectable and is marked", async () => {
  await deactivate();
  render(<HomeFields store={store} home_location_id={null} home_user_id="sam" sub_location="" onChange={() => {}} />);
  expect(screen.getByRole("option", { name: "Sam (inactive)" })).toBeInTheDocument();
});

test("the filter offers people who keep gear", async () => {
  const onChange = vi.fn();
  render(<FilterFields store={store} filter={{}} onChange={onChange} />);
  const select = screen.getByLabelText("Location");
  expect(
    within(select)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["Any", "Cold locker", "Sam"]);
  await user.selectOptions(select, "Sam");
  expect(onChange).toHaveBeenLastCalledWith({ home_user_id: "sam", location_id: undefined, sub_location: undefined });
});

test("the item page shows who keeps it, and inactive", async () => {
  navigate(`/items/${pole}`);
  const view = renderInShell(<ItemPage store={store} id={pole} />);
  expect(screen.getByText("Kept by Sam")).toBeInTheDocument();
  view.unmount();
  await deactivate();
  renderInShell(<ItemPage store={store} id={pole} />);
  expect(screen.getByText("Kept by Sam (inactive)")).toBeInTheDocument();
});

test("the item page edits a home from a location to a person", async () => {
  const tent = await act.createItem(store, { name: "Tent", home_location_id: cold, sub_location: "shelf 4" });
  navigate(`/items/${tent}`);
  renderInShell(<ItemPage store={store} id={tent} />);
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.selectOptions(screen.getByLabelText("Home location"), "Sam");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Kept by Sam")).toBeInTheDocument();
  expect(inv.item(store.state, tent)).toMatchObject({
    home_user_id: "sam",
    home_location_id: null,
    sub_location: null,
  });
});

test("the scan card for gear that is out says it goes back with the person", async () => {
  const camera = fakeCamera();
  await printCodes(store, ["AAAAAAAAAA"]);
  await act.bindCode(store, "AAAAAAAAAA", pole);
  await checkOut(store, pole);
  navigate("/scan");
  renderInShell(<Scan store={store} native />);
  await camera.scan("AAAAAAAAAA");
  const card = await screen.findByRole("region", { name: "Flagpole" });
  expect(within(card).getByText("Back with Sam")).toHaveClass("move-home");
});

test("a person home is not missing a shelf", () => {
  expect(inv.search(store.state, { needs: "shelf" }).map((i) => i.id)).not.toContain(pole);
});

test("the filter hides Shelf for a person, and shows a person who keeps nothing", () => {
  const { rerender } = render(<FilterFields store={store} filter={{ home_user_id: "sam" }} onChange={() => {}} />);
  expect(screen.queryByLabelText("Shelf")).not.toBeInTheDocument();
  rerender(<FilterFields store={store} filter={{ home_user_id: "carol" }} onChange={() => {}} />);
  expect(screen.getByLabelText("Location")).toHaveValue("user:carol");
  expect(screen.getByRole("option", { name: "Carol" })).toBeInTheDocument();
});
