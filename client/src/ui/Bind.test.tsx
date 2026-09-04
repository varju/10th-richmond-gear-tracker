import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { codeStatus, currentCode } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { Bind } from "./Bind";
import { openStore, printCodes } from "./codeTestKit";

let store: Store;
let tent: string;
let stove: string;

beforeEach(async () => {
  store = await openStore();
  await printCodes(store, ["AAAAAAAAAA", "BBBBBBBBBB"]);
  const cold = await act.createLocation(store, "Cold locker");
  tent = await act.createItem(store, { name: "Tent", home_location_id: cold, sub_location: "shelf 4" });
  stove = await act.createItem(store, { name: "Stove" });
  await act.bindCode(store, "AAAAAAAAAA", tent);
});

test("picking an item without a code binds straight away", async () => {
  const user = userEvent.setup();
  navigate("/bind/BBBBBBBBBB");
  render(<Bind store={store} code="BBBBBBBBBB" />);
  await user.type(screen.getByLabelText("Search items"), "sto");
  expect(screen.queryByText("Tent")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Stove/ }));
  await waitFor(() => expect(location.pathname).toBe(`/items/${stove}`));
  expect(currentCode(store.state, stove)?.id).toBe("BBBBBBBBBB");
});

test("an item that already has a code asks before replacing it (FR-TAG-04)", async () => {
  const user = userEvent.setup();
  navigate("/bind/BBBBBBBBBB");
  render(<Bind store={store} code="BBBBBBBBBB" />);
  await user.click(screen.getByRole("button", { name: /Tent/ }));
  expect(screen.getByText(/Replace its code/)).toHaveTextContent("AAAAAAAAAA");
  expect(currentCode(store.state, tent)?.id).toBe("AAAAAAAAAA");

  await user.click(screen.getByRole("button", { name: "Replace" }));
  await waitFor(() => expect(location.pathname).toBe(`/items/${tent}`));
  expect(currentCode(store.state, tent)?.id).toBe("BBBBBBBBBB");
  expect(codeStatus(store.state, "AAAAAAAAAA")).toBe("replaced");
});

test("a pool is offered too, and can take a code the same way (FR-TAG-15)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  const user = userEvent.setup();
  navigate("/bind/BBBBBBBBBB");
  render(<Bind store={store} code="BBBBBBBBBB" />);
  await user.type(screen.getByLabelText("Search items"), "bowl");
  await user.click(screen.getByRole("button", { name: /Bowls/ }));
  await waitFor(() => expect(location.pathname).toBe(`/items/${bowls}`));
  expect(currentCode(store.state, bowls)?.id).toBe("BBBBBBBBBB");
});

test("a code that is no longer free says why", async () => {
  navigate("/bind/AAAAAAAAAA");
  render(<Bind store={store} code="AAAAAAAAAA" />);
  expect(screen.getByText("Already on Tent.")).toBeInTheDocument();
  expect(screen.queryByLabelText("Search items")).not.toBeInTheDocument();
});
