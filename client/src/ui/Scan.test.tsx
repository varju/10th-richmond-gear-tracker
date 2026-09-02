import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { currentCode } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { openStore, printCodes } from "./codeTestKit";
import { Scan } from "./Scan";

let store: Store;
let tent: string;

beforeEach(async () => {
  store = await openStore();
  await printCodes(store, ["AAAAAAAAAA", "BBBBBBBBBB"]);
  tent = await act.createItem(store, { name: "Tent" });
  const stove = await act.createItem(store, { name: "Stove" });
  await act.bindCode(store, "AAAAAAAAAA", stove);
});

async function typeCode(text: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Type a code instead" }));
  await user.type(screen.getByLabelText("Code or URL"), text);
  await user.click(screen.getByRole("button", { name: "Go" }));
}

test("without a camera the screen says so and still takes a typed code", async () => {
  navigate("/scan");
  render(<Scan store={store} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("No camera");
  await typeCode("https://varju.ca/g/bbbbbbbbbb");
  expect(location.pathname).toBe("/g/BBBBBBBBBB");
});

test("something that is not a code is refused", async () => {
  navigate("/scan");
  render(<Scan store={store} />);
  await typeCode("hello");
  expect(screen.getByRole("status")).toHaveTextContent("Not a gear code");
  expect(location.pathname).toBe("/scan");
});

test("with ?for= an unassigned code is bound to the item (FR-TAG-04)", async () => {
  navigate(`/scan?for=${tent}`);
  render(<Scan store={store} />);
  await typeCode("BBBBBBBBBB");
  await waitFor(() => expect(location.pathname).toBe(`/items/${tent}`));
  expect(currentCode(store.state, tent)?.id).toBe("BBBBBBBBBB");
});

test("with ?for= a code already on another item is refused", async () => {
  navigate(`/scan?for=${tent}`);
  render(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  expect(await screen.findByRole("status")).toHaveTextContent("That code is already on Stove");
  expect(currentCode(store.state, tent)).toBeUndefined();
  expect(location.pathname).toBe("/scan");
});

test("with ?for= an unknown code is refused", async () => {
  navigate(`/scan?for=${tent}`);
  render(<Scan store={store} />);
  await typeCode("ZZZZZZZZZZ");
  expect(await screen.findByRole("status")).toHaveTextContent("Not one of our codes");
  expect(location.pathname).toBe("/scan");
});
