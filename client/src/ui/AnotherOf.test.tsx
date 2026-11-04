import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as inv from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { AnotherOf } from "./AnotherOf";
import { openStore, printCodes } from "./codeTestKit";

let store: Store;

beforeEach(async () => {
  store = await openStore();
  await printCodes(store, ["CCCCCCCCCC"]);
});

test("a tap makes the next unit with the generic's home, labels it, and returns to the scanner (FR-INV-24)", async () => {
  const user = userEvent.setup();
  await act.createGeneric(store, { name: "Stove" });
  const cold = await act.createLocation(store, "Cold locker");
  const tents = await act.createGeneric(store, { name: "4-person tent", home_location_id: cold });
  await printCodes(store, ["BBBBBBBBBB"]);
  await act.bindCode(store, "BBBBBBBBBB", await act.addUnit(store, tents));
  navigate("/scan");
  navigate("/another/CCCCCCCCCC");
  render(<AnotherOf store={store} code="CCCCCCCCCC" />);

  // The one labelled last is first.
  const names = within(screen.getByRole("list"))
    .getAllByRole("button")
    .map((b) => b.textContent);
  expect(names[0]).toContain("4-person tent");
  expect(names[0]).toContain("#2");

  await user.click(screen.getByRole("button", { name: /4-person tent/ }));
  await waitFor(() => expect(location.pathname).toBe("/scan"));
  const units = inv.unitsOf(store.state, tents);
  expect(units.map((u) => inv.displayName(store.state, u))).toEqual(["4-person tent #1", "4-person tent #2"]);
  expect(units[1]).toMatchObject({ home_location_id: cold });
  expect(inv.currentCode(store.state, units[1]!.id)?.id).toBe("CCCCCCCCCC");
});

test("search narrows the list, and a typed number is used instead of the next one", async () => {
  const user = userEvent.setup();
  const tents = await act.createGeneric(store, { name: "4-person tent" });
  await act.createGeneric(store, { name: "Stove" });
  navigate("/another/CCCCCCCCCC");
  render(<AnotherOf store={store} code="CCCCCCCCCC" />);

  await user.type(screen.getByLabelText("Search"), "stove");
  expect(screen.queryByRole("button", { name: /4-person tent/ })).not.toBeInTheDocument();
  await user.clear(screen.getByLabelText("Search"));
  await user.type(screen.getByLabelText("Number"), "7");
  expect(screen.getByRole("button", { name: /4-person tent/ })).toHaveTextContent("#7");
  await user.click(screen.getByRole("button", { name: /4-person tent/ }));
  await waitFor(() => expect(inv.unitsOf(store.state, tents)).toHaveLength(1));
  expect(inv.displayName(store.state, inv.unitsOf(store.state, tents)[0]!)).toBe("4-person tent #7");
});

const open = (store_: Store) => {
  navigate("/scan");
  navigate("/another/CCCCCCCCCC");
  render(<AnotherOf store={store_} code="CCCCCCCCCC" />);
};

test("counted units take codes in order with no new unit (FR-INV-54)", async () => {
  const user = userEvent.setup();
  await printCodes(store, ["DDDDDDDDDD"]);
  const tents = await act.createGeneric(store, { name: "Tent" });
  await act.addUnits(store, tents, 3);
  open(store);
  expect(screen.getByRole("button", { name: /Tent/ })).toHaveTextContent("#1 · no code yet");
  await user.click(screen.getByRole("button", { name: /Tent/ }));
  await waitFor(() => expect(location.pathname).toBe("/scan"));
  const units = inv.unitsOf(store.state, tents);
  expect(units).toHaveLength(3);
  expect(inv.currentCode(store.state, units[0]!.id)?.id).toBe("CCCCCCCCCC");

  cleanup();
  navigate("/scan");
  navigate("/another/DDDDDDDDDD");
  render(<AnotherOf store={store} code="DDDDDDDDDD" />);
  expect(screen.getByRole("button", { name: /Tent/ })).toHaveTextContent("#2 · no code yet");
  await user.click(screen.getByRole("button", { name: /Tent/ }));
  await waitFor(() => expect(inv.currentCode(store.state, units[1]!.id)?.id).toBe("DDDDDDDDDD"));
  expect(inv.unitsOf(store.state, tents)).toHaveLength(3);
});

test("a retired or missing unit is passed over", async () => {
  const user = userEvent.setup();
  const tents = await act.createGeneric(store, { name: "Tent" });
  const [a, b, c] = await act.addUnits(store, tents, 3);
  await act.retireItem(store, a!);
  await act.markMissing(store, b!);
  open(store);
  expect(screen.getByRole("button", { name: /Tent/ })).toHaveTextContent("#3 · no code yet");
  await user.click(screen.getByRole("button", { name: /Tent/ }));
  await waitFor(() => expect(inv.currentCode(store.state, c!)?.id).toBe("CCCCCCCCCC"));
  expect(inv.unitsOf(store.state, tents)).toHaveLength(3);
});

test("a typed number of a waiting unit binds to it", async () => {
  const user = userEvent.setup();
  const tents = await act.createGeneric(store, { name: "Tent" });
  const [, two] = await act.addUnits(store, tents, 3);
  open(store);
  await user.type(screen.getByLabelText("Number"), "2");
  expect(screen.getByRole("button", { name: /Tent/ })).toHaveTextContent("#2 · no code yet");
  await user.click(screen.getByRole("button", { name: /Tent/ }));
  await waitFor(() => expect(inv.currentCode(store.state, two!)?.id).toBe("CCCCCCCCCC"));
  expect(inv.unitsOf(store.state, tents)).toHaveLength(3);
});

test("a typed free number makes a new unit", async () => {
  const user = userEvent.setup();
  const tents = await act.createGeneric(store, { name: "Tent" });
  await act.addUnits(store, tents, 2);
  open(store);
  await user.type(screen.getByLabelText("Number"), "9");
  await user.click(screen.getByRole("button", { name: /Tent/ }));
  await waitFor(() => expect(inv.unitsOf(store.state, tents)).toHaveLength(3));
  expect(inv.unitsOf(store.state, tents).map((u) => u.number)).toEqual(["1", "2", "9"]);
});

test("a typed number of a unit that has a code is taken", async () => {
  const user = userEvent.setup();
  await printCodes(store, ["EEEEEEEEEE"]);
  const tents = await act.createGeneric(store, { name: "Tent" });
  const [one] = await act.addUnits(store, tents, 2);
  await act.bindCode(store, "EEEEEEEEEE", one!);
  open(store);
  await user.type(screen.getByLabelText("Number"), "1");
  await user.click(screen.getByRole("button", { name: /Tent/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("#1 is taken");
  expect(inv.unitsOf(store.state, tents)).toHaveLength(2);
});

test("a generic with every unit coded makes a new unit as before", async () => {
  const user = userEvent.setup();
  await printCodes(store, ["EEEEEEEEEE"]);
  const tents = await act.createGeneric(store, { name: "Tent" });
  const [one] = await act.addUnits(store, tents, 1);
  await act.bindCode(store, "EEEEEEEEEE", one!);
  open(store);
  expect(screen.getByRole("button", { name: /Tent/ })).toHaveTextContent("#2");
  await user.click(screen.getByRole("button", { name: /Tent/ }));
  await waitFor(() => expect(inv.unitsOf(store.state, tents)).toHaveLength(2));
});
