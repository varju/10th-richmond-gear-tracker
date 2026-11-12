import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { item } from "../lib/inventory";
import * as mv from "../lib/movement";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore, printCodes } from "./codeTestKit";
import { ItemList } from "./ItemList";
import { ItemPage } from "./ItemPage";
import { alice, inSession, renderInShell, seedUsers } from "./moveTestKit";
import { NewItem } from "./NewItem";
import { Scan } from "./Scan";
import { fakeCamera, stopFakeCamera } from "./scanTestKit";
import { rows } from "../lib/inventory";

// Gear weighed to see what is left (FR-INV-62 to FR-INV-68).
let store: Store;
let tank: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
  await inSession(store);
  tank = await act.createItem(store, {
    name: "Propane",
    empty_weight: { value: 18, unit: "lb" },
    capacity: { value: 20, unit: "lb" },
  });
  navigate(`/items/${tank}`);
});

afterEach(() => {
  cleanup();
  unsaved.cancel();
  stopFakeCamera();
});

const user = userEvent.setup();
const events = (type: string) => store.pending.filter((e) => e.type === type).map((e) => e.payload);

test("the page shows Not weighed, then what is left and when, in the item's unit", async () => {
  renderInShell(<ItemPage store={store} id={tank} />);
  expect(screen.getByText("Left").nextElementSibling).toHaveTextContent("Not weighed");

  await mv.weigh(store, tank, { value: 12, unit: "kg" });
  await waitFor(() =>
    expect(screen.getByText("Left").nextElementSibling).toHaveTextContent("About 8.5 lb left (42%) · weighed just now"),
  );
});

test("an item with no empty weight and capacity shows no Left line and no weigh buttons", async () => {
  const tent = await act.createItem(store, { name: "Tent" });
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.queryByText("Left")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Weigh" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Refilled" })).not.toBeInTheDocument();
});

test("Weigh records the number and unit as typed, with the unit switch starting on the item's", async () => {
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Weigh" }));
  expect(screen.getByRole("button", { name: "lb" })).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "kg" }));
  await user.type(screen.getByLabelText("Weight now"), "10");
  await user.click(screen.getByRole("button", { name: "Save weight" }));

  await waitFor(() => expect(events("weighed")).toEqual([{ value: 10, unit: "kg" }]));
  expect(screen.getByText("Left").nextElementSibling).toHaveTextContent("About 4 lb left (20%)");
  // The form is gone, the buttons are back.
  expect(screen.getByRole("button", { name: "Weigh" })).toBeInTheDocument();
});

test("Weigh then Unknown clears what is left", async () => {
  await mv.weigh(store, tank, { value: 30, unit: "lb" });
  renderInShell(<ItemPage store={store} id={tank} />);
  expect(screen.getByText("Left").nextElementSibling).toHaveTextContent("About");
  await user.click(screen.getByRole("button", { name: "Weigh" }));
  await user.click(screen.getByRole("button", { name: "Unknown" }));
  await waitFor(() => expect(events("weighed").at(-1)).toEqual({ value: null }));
  await waitFor(() => expect(screen.getByText("Left").nextElementSibling).toHaveTextContent("Not weighed"));
  expect(screen.getByRole("button", { name: "Weigh" })).toBeInTheDocument();
});

test("Weigh needs a number", async () => {
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Weigh" }));
  expect(screen.getByRole("button", { name: "Save weight" })).toBeDisabled();
  await user.type(screen.getByLabelText("Weight now"), "abc");
  expect(screen.getByRole("button", { name: "Save weight" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(events("weighed")).toEqual([]);
});

test("Refilled sets it full in one tap", async () => {
  await mv.weigh(store, tank, { value: 19, unit: "lb" });
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Refilled" }));
  await waitFor(() => expect(events("refilled")).toEqual([{}]));
  expect(screen.getByText("Left").nextElementSibling).toHaveTextContent("Full (20 lb) · refilled just now");
});

test("the edit page sets an empty weight and a capacity, each with its own unit", async () => {
  const tent = await act.createItem(store, { name: "Tent" });
  navigate(`/items/${tent}`);
  renderInShell(<ItemPage store={store} id={tent} />);
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.click(screen.getByText("Weighed to see what is left"));

  await user.type(screen.getByLabelText("Empty weight"), "8");
  await user.click(
    within(screen.getByRole("group", { name: "Empty weight unit" })).getByRole("button", { name: "kg" }),
  );
  await user.type(screen.getByLabelText("Capacity"), "9.5");
  // The capacity's unit starts on the empty weight's.
  expect(
    within(screen.getByRole("group", { name: "Capacity unit" })).getByRole("button", { name: "lb" }),
  ).toHaveAttribute("aria-pressed", "true");
  await user.click(within(screen.getByRole("group", { name: "Capacity unit" })).getByRole("button", { name: "kg" }));
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(item(store.state, tent)).toMatchObject({
      empty_weight: { value: 8, unit: "kg" },
      capacity: { value: 9.5, unit: "kg" },
    }),
  );
});

test("clearing a weight on the edit page records null", async () => {
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.clear(screen.getByLabelText("Capacity"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(item(store.state, tank)?.capacity).toBeNull());
  expect(item(store.state, tank)?.empty_weight).toEqual({ value: 18, unit: "lb" });
});

test("a unit's edit page offers both and says capacity can come from its generic", async () => {
  const generic = await act.createGeneric(store, { name: "Tanks", capacity: { value: 20, unit: "lb" } });
  const unit = await act.createUnit(store, { parent_id: generic, number: "1" });
  navigate(`/items/${unit}`);
  renderInShell(<ItemPage store={store} id={unit} />);
  await user.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Empty weight")).toBeInTheDocument();
  expect(screen.getByText(/Leave capacity empty to use the generic’s, 20 lb/)).toBeInTheDocument();
});

test("a generic's edit page has a capacity and no empty weight", async () => {
  const generic = await act.createGeneric(store, { name: "Tanks" });
  navigate(`/items/${generic}`);
  renderInShell(<ItemPage store={store} id={generic} />);
  await user.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Capacity")).toBeInTheDocument();
  expect(screen.queryByLabelText("Empty weight")).not.toBeInTheDocument();
});

test("Return on a weighed item asks the weight first; a number and the item's unit go with the check-in", async () => {
  await mv.checkOut(store, tank);
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Return" }));
  // Nothing recorded yet.
  expect(events("checked_in")).toEqual([]);
  expect(screen.getByRole("button", { name: "lb" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Empty 18 lb, holds 20 lb.")).toBeInTheDocument();
  await user.type(screen.getByLabelText("Weight now"), "25{Enter}");

  await waitFor(() => expect(events("weighed")).toEqual([{ value: 25, unit: "lb" }]));
  expect(item(store.state, tank)?.status).toBe("in");
  expect(store.pending.slice(-2).map((e) => e.type)).toEqual(["checked_in", "weighed"]);
});

test("the weight prompt does not crash when a sync clears the capacity", async () => {
  await mv.checkOut(store, tank);
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Return" }));
  expect(screen.getByLabelText("Weight now")).toBeInTheDocument();
  await act.updateItem(store, tank, { capacity: null });
  await waitFor(() => expect(screen.queryByLabelText("Weight now")).not.toBeInTheDocument());
  expect(screen.getByRole("heading", { name: "Propane" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Return" })).toBeInTheDocument();
  await act.updateItem(store, tank, { capacity: { value: 20, unit: "lb" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Return" })).toBeInTheDocument());
  expect(screen.queryByLabelText("Weight now")).not.toBeInTheDocument();
});

test("Return always asks the weight, even when it was weighed or refilled since it went out", async () => {
  await mv.checkOut(store, tank);
  await mv.weigh(store, tank, { value: 28, unit: "lb" });
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Return" }));
  expect(screen.getByLabelText("Weight now")).toBeInTheDocument();
  expect(item(store.state, tank)?.status).toBe("out");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await mv.refill(store, tank);
  await user.click(screen.getByRole("button", { name: "Return" }));
  expect(screen.getByLabelText("Weight now")).toBeInTheDocument();
});

test("Keep shows the last reading, even one from before it went out, and records it as current", async () => {
  await mv.weigh(store, tank, { value: 28, unit: "lb" });
  await mv.checkOut(store, tank);
  expect(item(store.state, tank)?.reading).toMatchObject({ stale: true });
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Return" }));
  expect(screen.getByRole("button", { name: "Keep 28 lb" })).toHaveClass("primary");
  await user.click(screen.getByRole("button", { name: "Keep 28 lb" }));

  await waitFor(() => expect(events("weighed")).toHaveLength(2));
  expect(events("weighed")).toEqual([
    { value: 28, unit: "lb" },
    { value: 28, unit: "lb" },
  ]);
  expect(item(store.state, tank)?.reading).not.toHaveProperty("stale");
  expect(item(store.state, tank)?.reading).toMatchObject({ value: 28, unit: "lb" });
});

test("Keep after Refilled says Full and keeps it full", async () => {
  await mv.refill(store, tank);
  await mv.checkOut(store, tank);
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Return" }));
  await user.click(screen.getByRole("button", { name: "Keep Full" }));
  await waitFor(() => expect(events("refilled")).toHaveLength(2));
  expect(item(store.state, tank)?.reading).toMatchObject({ full: true });
  expect(item(store.state, tank)?.reading).not.toHaveProperty("stale");
});

test("Keep is not offered when there is no reading", async () => {
  await mv.checkOut(store, tank);
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Return" }));
  expect(screen.queryByRole("button", { name: /^Keep/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Unknown" })).toBeInTheDocument();
});

test("Unknown returns the item in one tap and clears what is left", async () => {
  await mv.weigh(store, tank, { value: 30, unit: "lb" });
  await mv.checkOut(store, tank);
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Return" }));
  await user.click(screen.getByRole("button", { name: "Unknown" }));

  await waitFor(() => expect(events("weighed").at(-1)).toEqual({ value: null }));
  expect(item(store.state, tank)?.status).toBe("in");
  expect(item(store.state, tank)?.reading).toBeNull();
});

test("a scan's card hides Weigh and Refilled while the Return weight prompt is open", async () => {
  await printCodes(store, ["AAAAAAAAAA"]);
  await act.bindCode(store, "AAAAAAAAAA", tank);
  await mv.weigh(store, tank, { value: 28, unit: "lb" });
  await mv.checkOut(store, tank);
  navigate("/scan");
  const camera = fakeCamera();
  renderInShell(<Scan store={store} native />);
  await camera.scan("AAAAAAAAAA");
  const card = await screen.findByRole("region", { name: "Propane" });
  expect(within(card).getByRole("button", { name: "Weigh" })).toBeInTheDocument();
  await user.click(within(card).getByRole("button", { name: "Return" }));
  expect(screen.getByLabelText("Weight now")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Weigh" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Refilled" })).not.toBeInTheDocument();
});

test("a scan's card offers Weigh and Refilled for a weighed item, and not for a plain one", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await printCodes(store, ["AAAAAAAAAA", "BBBBBBBBBB"]);
  await act.bindCode(store, "AAAAAAAAAA", tank);
  await act.bindCode(store, "BBBBBBBBBB", stove);
  navigate("/scan");
  const camera = fakeCamera();
  renderInShell(<Scan store={store} native />);
  await camera.scan("AAAAAAAAAA");
  const card = await screen.findByRole("region", { name: "Propane" });
  expect(within(card).getByRole("button", { name: "Weigh" })).toBeInTheDocument();
  expect(within(card).getByRole("button", { name: "Refilled" })).toBeInTheDocument();
  await user.click(within(card).getByRole("button", { name: "Skip" }));
  await camera.scan("BBBBBBBBBB");
  const plain = await screen.findByRole("region", { name: "Stove" });
  expect(within(plain).queryByRole("button", { name: "Weigh" })).not.toBeInTheDocument();
});

test("the weight prompt can be cancelled without returning it", async () => {
  await mv.checkOut(store, tank);
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Return" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(item(store.state, tank)?.status).toBe("out");
  expect(screen.getByRole("button", { name: "Return" })).toBeInTheDocument();
});

test("gear that is not weighed returns at once, as before", async () => {
  const tent = await act.createItem(store, { name: "Tent" });
  await mv.checkOut(store, tent);
  navigate(`/items/${tent}`);
  renderInShell(<ItemPage store={store} id={tent} />);
  await user.click(screen.getByRole("button", { name: "Return" }));
  await waitFor(() => expect(item(store.state, tent)?.status).toBe("in"));
  expect(events("weighed")).toEqual([]);
});

test("the scanner's card asks the weight on Return, and Unknown is allowed", async () => {
  const camera = fakeCamera();
  await printCodes(store, ["AAAAAAAAAA"]);
  await act.bindCode(store, "AAAAAAAAAA", tank);
  await mv.checkOut(store, tank);
  navigate("/scan");
  renderInShell(<Scan store={store} native />);
  await camera.scan("AAAAAAAAAA");
  const card = await screen.findByRole("region", { name: "Propane" });
  await user.click(within(card).getByRole("button", { name: "Return" }));
  await user.type(screen.getByLabelText("Weight now"), "9");
  await user.click(screen.getByRole("button", { name: "kg" }));
  await user.click(screen.getByRole("button", { name: "Return" }));
  await waitFor(() => expect(events("weighed")).toEqual([{ value: 9, unit: "kg" }]));
  expect(item(store.state, tank)?.status).toBe("in");
});

test("the list shows what is left beside the home, and nothing for gear never weighed", async () => {
  await act.createItem(store, { name: "Tent" });
  await mv.weigh(store, tank, { value: 26, unit: "lb" });
  renderInShell(<ItemList store={store} list={rows(store.state, {})} />);
  expect(screen.getByRole("button", { name: /Propane/ })).toHaveTextContent("About 8 lb left (40%)");
  expect(screen.getByRole("button", { name: /Tent/ })).not.toHaveTextContent("left");
});

test("text that is not a number holds Save and says so; only a blank box clears", async () => {
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Edit" }));
  const capacity = screen.getByLabelText("Capacity");

  await user.clear(capacity);
  await user.type(capacity, "20 lb");
  expect(screen.getByRole("alert")).toHaveTextContent("A number above zero.");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await user.clear(capacity);
  await user.type(capacity, "0");
  expect(screen.getByRole("alert")).toHaveTextContent("A number above zero.");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await user.clear(capacity);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

  await user.type(capacity, "25");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(item(store.state, tank)?.capacity).toEqual({ value: 25, unit: "lb" }));
});

test("a bad empty weight holds Save, and a zero one is fine", async () => {
  renderInShell(<ItemPage store={store} id={tank} />);
  await user.click(screen.getByRole("button", { name: "Edit" }));
  const empty = screen.getByLabelText("Empty weight");
  await user.clear(empty);
  await user.type(empty, "-3");
  expect(screen.getByRole("alert")).toHaveTextContent("A number of zero or more.");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.clear(empty);
  await user.type(empty, "0");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("a duplicate starts with the weights", async () => {
  renderInShell(<NewItem store={store} code={null} from={tank} />);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(store.pending.filter((e) => e.type === "created" && e.payload.name === "Propane")).toHaveLength(2),
  );
  const made = store.pending.filter((e) => e.type === "created" && e.payload.name === "Propane").at(-1)!;
  expect(made.payload).toMatchObject({ empty_weight: { value: 18, unit: "lb" }, capacity: { value: 20, unit: "lb" } });
});

test("a reading from before the item went out is not shown as what is left", async () => {
  await mv.weigh(store, tank, { value: 28, unit: "lb" });
  await mv.checkOut(store, tank);
  await mv.checkIn(store, tank);
  renderInShell(<ItemPage store={store} id={tank} />);
  expect(screen.getByText("Left").nextElementSibling).toHaveTextContent("Not weighed since it came back");
  await user.click(screen.getByRole("button", { name: "Weigh" }));
  await user.type(screen.getByLabelText("Weight now"), "28{Enter}");
  await waitFor(() => expect(screen.getByText("Left").nextElementSibling).toHaveTextContent("About 10 lb left"));
});
