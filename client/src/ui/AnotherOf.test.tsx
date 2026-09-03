import { render, screen, waitFor, within } from "@testing-library/react";
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
  await act.addUnit(store, tents);
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
