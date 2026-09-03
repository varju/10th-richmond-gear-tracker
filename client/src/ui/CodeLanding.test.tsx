import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as inv from "../lib/inventory";
import { back, navigate } from "../lib/router";
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
  // Straight off a sticker, with nothing behind it: Scan again has to fall back.
  navigate("/g/ZZZZZZZZZZ", true);
  render(<CodeLanding store={store} code="ZZZZZZZZZZ" />);
  expect(screen.getByRole("heading", { name: "Not one of our codes" })).toBeInTheDocument();
  expect(screen.getByText("ZZZZZZZZZZ")).toBeInTheDocument();
  expect(screen.getByText(/sync first/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Scan again" }));
  expect(location.pathname).toBe("/scan");
});

test("a sticker on a merged duplicate opens the survivor (FR-INV-13)", async () => {
  const dup = await act.createItem(store, { name: "Tent" });
  const tent = await act.createItem(store, { name: "Tent (again)" });
  await act.bindCode(store, "AAAAAAAAAA", dup);
  await act.mergeItem(store, dup, tent);
  navigate("/g/AAAAAAAAAA");
  render(<CodeLanding store={store} code="AAAAAAAAAA" />);
  await waitFor(() => expect(location.pathname).toBe(`/items/${tent}`));
});

test("an unassigned code offers another of something we have several of (FR-INV-24)", async () => {
  const user = userEvent.setup();
  await act.createGeneric(store, { name: "4-person tent" });
  navigate("/scan");
  navigate("/g/CCCCCCCCCC");
  render(<CodeLanding store={store} code="CCCCCCCCCC" />);
  await user.click(screen.getByRole("button", { name: "Another of…" }));
  expect(location.pathname).toBe("/another/CCCCCCCCCC");
});

test("the code screen steps aside, so back from what it opens returns to the scanner", async () => {
  const user = userEvent.setup();
  navigate("/scan");
  navigate("/g/CCCCCCCCCC");
  render(<CodeLanding store={store} code="CCCCCCCCCC" />);

  await user.click(screen.getByRole("button", { name: "Create a new item" }));
  expect(location.pathname + location.search).toBe("/items/new?code=CCCCCCCCCC");
  back("/");
  expect(location.pathname).toBe("/scan");

  navigate("/g/CCCCCCCCCC");
  await user.click(screen.getByRole("button", { name: "Put it on an existing item" }));
  expect(location.pathname).toBe("/bind/CCCCCCCCCC");
  back("/");
  expect(location.pathname).toBe("/scan");
});

test("a code on a deleted item still opens the item, which says so (FR-INV-32)", async () => {
  const tent = await act.createItem(store, { name: "Tent" });
  await act.bindCode(store, "AAAAAAAAAA", tent);
  await act.deleteItem(store, tent);
  navigate("/g/AAAAAAAAAA");
  render(<CodeLanding store={store} code="AAAAAAAAAA" />);
  // The code binds once, so it stays on the item; the item page carries the notice.
  await waitFor(() => expect(location.pathname).toBe(`/items/${tent}`));
  expect(inv.codeStatus(store.state, "AAAAAAAAAA")).toBe("assigned");
});
