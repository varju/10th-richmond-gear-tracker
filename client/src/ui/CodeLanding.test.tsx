import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { CodeLanding } from "./CodeLanding";
import { openStore, printCodes } from "./codeTestKit";

let store: Store;

beforeEach(async () => {
  store = await openStore();
  await printCodes(store, ["AAAAAAAAAA", "BBBBBBBBBB", "CCCCCCCCCC"]);
});

test("an assigned code opens its item", async () => {
  const tent = await act.createItem(store, { name: "Tent" });
  await act.bindCode(store, "AAAAAAAAAA", tent);
  navigate("/g/AAAAAAAAAA");
  render(<CodeLanding store={store} code="AAAAAAAAAA" />);
  await waitFor(() => expect(location.pathname).toBe(`/items/${tent}`));
});

test("a replaced code still opens its item (FR-TAG-05)", async () => {
  const tent = await act.createItem(store, { name: "Tent" });
  await act.bindCode(store, "AAAAAAAAAA", tent);
  await act.bindCode(store, "BBBBBBBBBB", tent);
  navigate("/g/AAAAAAAAAA");
  render(<CodeLanding store={store} code="AAAAAAAAAA" />);
  await waitFor(() => expect(location.pathname).toBe(`/items/${tent}`));
});

test("an unassigned code offers create or bind (FR-TAG-07)", async () => {
  const user = userEvent.setup();
  navigate("/g/CCCCCCCCCC");
  render(<CodeLanding store={store} code="CCCCCCCCCC" />);
  expect(screen.getByRole("heading", { name: "New code" })).toBeInTheDocument();
  expect(screen.getByText("CCCCCCCCCC")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Put it on an existing item" }));
  expect(location.pathname).toBe("/bind/CCCCCCCCCC");

  await user.click(screen.getByRole("button", { name: "Create a new item" }));
  expect(location.pathname + location.search).toBe("/items/new?code=CCCCCCCCCC");
});

test("a code this device has never heard of says so and suggests a sync", async () => {
  const user = userEvent.setup();
  navigate("/g/ZZZZZZZZZZ");
  render(<CodeLanding store={store} code="ZZZZZZZZZZ" />);
  expect(screen.getByRole("heading", { name: "Not one of our codes" })).toBeInTheDocument();
  expect(screen.getByText("ZZZZZZZZZZ")).toBeInTheDocument();
  expect(screen.getByText(/sync first/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Scan again" }));
  expect(location.pathname).toBe("/scan");
});
