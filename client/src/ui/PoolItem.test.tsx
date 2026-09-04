import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as inv from "../lib/inventory";
import * as mv from "../lib/movement";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore, printCodes } from "./codeTestKit";
import { ItemPage } from "./ItemPage";
import { alice, carol, renderInShell, seedUsers } from "./moveTestKit";

// A counted stack: its page, its counts, and turning a single item into one (FR-INV-34, FR-INV-36).
let store: Store;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice, carol]);
});

afterEach(() => unsaved.cancel());

const user = userEvent.setup();
const fact = (label: string) => (screen.getByText(label).nextElementSibling as HTMLElement).textContent;

test("a pool page shows owned, in, and out by holder, and moves by count (FR-INV-36, FR-OUT-22, FR-OUT-23)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await mv.checkOutPool(store, bowls, { count: 6, event: "Fall Camp" });
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Bowls");
  expect(screen.getByText("Counted stack")).toBeInTheDocument();
  expect(fact("Owned")).toBe("20");
  expect(fact("In")).toBe("14");
  expect(fact("Out")).toBe("Alice · 6");

  // Check out some more, against the session's event.
  await user.click(screen.getByRole("button", { name: "Check out" }));
  expect(screen.getByText("No event")).toBeInTheDocument();
  const count = screen.getByLabelText("How many");
  await user.clear(count);
  await user.type(count, "4");
  await user.click(screen.getByRole("button", { name: "Check out" }));
  await waitFor(() => expect(inv.poolCounts(inv.item(store.state, bowls)!).in).toBe(10));
  expect(await screen.findByText("Checked out 4 · Bowls")).toBeInTheDocument();

  // Return: prefilled with what the signed-in person has out.
  await user.click(screen.getByRole("button", { name: "Return" }));
  expect(screen.getByLabelText("How many")).toHaveValue(10);
  await user.click(screen.getByRole("button", { name: "Return" }));
  await waitFor(() => expect(inv.poolCounts(inv.item(store.state, bowls)!).in).toBe(20));
  expect(inv.poolCounts(inv.item(store.state, bowls)!).out).toEqual([]);

  // Recount: prefilled with what is in now, and needs a reason.
  await user.click(screen.getByRole("button", { name: "Recount" }));
  expect(screen.getByLabelText("How many")).toHaveValue(20);
  expect(screen.getByRole("button", { name: "Recount" })).toBeDisabled();
  await user.clear(screen.getByLabelText("How many"));
  await user.type(screen.getByLabelText("How many"), "18");
  await user.type(screen.getByLabelText("Why"), "counted on the shelf");
  await user.click(screen.getByRole("button", { name: "Recount" }));
  await waitFor(() => expect(inv.item(store.state, bowls)?.pool_in).toBe(18));
  expect(await screen.findByText(/Recounted to 18 by Alice: counted on the shelf/)).toBeInTheDocument();
});

test("taking more than are in warns, and never blocks (FR-OUT-22)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 5);
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  await user.click(screen.getByRole("button", { name: "Check out" }));
  await user.clear(screen.getByLabelText("How many"));
  await user.type(screen.getByLabelText("How many"), "8");
  expect(screen.getByRole("note")).toHaveTextContent("Only 5 in");
  await user.click(screen.getByRole("button", { name: "Check out" }));
  await waitFor(() => expect(inv.item(store.state, bowls)?.pool_in).toBe(0));
  expect(inv.item(store.state, bowls)?.pool_out).toEqual({ alice: 8 });
});

test("anyone can return another's, picked from a list when more than one holder has some out (FR-OUT-23)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await mv.checkOutPool(store, bowls, { count: 6 });
  await store.setMeta({ user: carol });
  await mv.checkOutPool(store, bowls, { count: 3 });
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  // Carol is signed in and holds some, so she is the default; the list still offers Alice.
  await user.click(screen.getByRole("button", { name: "Return" }));
  const who = screen.getByLabelText("Who");
  expect(who).toHaveValue("carol");
  expect(screen.getByLabelText("How many")).toHaveValue(3);
  expect(screen.getByLabelText("How many")).toHaveAttribute("max", "3");

  await user.selectOptions(who, "alice");
  expect(screen.getByLabelText("How many")).toHaveValue(6);
  expect(screen.getByLabelText("How many")).toHaveAttribute("max", "6");
  await user.click(screen.getByRole("button", { name: "Return" }));

  await waitFor(() =>
    expect(inv.poolCounts(inv.item(store.state, bowls)!).out).toEqual([{ holder_id: "carol", count: 3 }]),
  );
});

test("returning more than a holder has out is refused, shown as an error (FR-OUT-23)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 5);
  await mv.checkOutPool(store, bowls, { count: 3 });
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  await user.click(screen.getByRole("button", { name: "Return" }));
  const count = screen.getByLabelText("How many");
  await user.clear(count);
  await user.type(count, "9");
  await user.click(screen.getByRole("button", { name: "Return" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("only 3 out to alice");
});

test("a pool page has no unit list, no group, and no make single (FR-INV-34)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 5);
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  expect(screen.queryByRole("heading", { name: "Units" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Group with/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Make this a single item/ })).not.toBeInTheDocument();
});

test("a pool's container can carry a code, on the pool page's Details (FR-TAG-15)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 5);
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  await user.click(screen.getByText("Details"));
  expect(fact("Code")).toBe("none");
  expect(screen.getByRole("button", { name: "Add QR code" })).toBeInTheDocument();

  await printCodes(store, ["ABCDEFGH23"]);
  await act.bindCode(store, "ABCDEFGH23", bowls);
  expect(fact("Code")).toBe("ABCDEFGH23");
  expect(screen.getByRole("button", { name: "Replace QR code" })).toBeInTheDocument();
});

test("a single item becomes a counted stack, the way it becomes a generic (FR-INV-26, FR-INV-34)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  navigate(`/items/${stove}`);
  renderInShell(<ItemPage store={store} id={stove} />);

  const quantity = screen.getByLabelText("How many");
  await user.clear(quantity);
  await user.type(quantity, "12");
  await user.click(screen.getByRole("button", { name: "Make this a counted stack…" }));
  await user.click(screen.getByRole("button", { name: "Really make it a counted stack?" }));

  await waitFor(() => expect(location.pathname).not.toBe(`/items/${stove}`));
  const poolId = location.pathname.split("/").at(-1)!;
  expect(inv.item(store.state, poolId)).toMatchObject({ name: "Stove", pool: true, pool_in: 12 });
  expect(inv.item(store.state, stove)?.merged_into).toBe(poolId);
});

test("a single item's code comes along when it becomes a counted stack (FR-TAG-15)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await printCodes(store, ["ABCDEFGH23"]);
  await act.bindCode(store, "ABCDEFGH23", stove);
  navigate(`/items/${stove}`);
  renderInShell(<ItemPage store={store} id={stove} />);

  await user.click(screen.getByRole("button", { name: "Make this a counted stack…" }));
  await user.click(screen.getByRole("button", { name: "Really make it a counted stack?" }));

  await waitFor(() => expect(location.pathname).not.toBe(`/items/${stove}`));
  const poolId = location.pathname.split("/").at(-1)!;
  expect(inv.currentCode(store.state, poolId)?.id).toBe("ABCDEFGH23");
  expect(inv.codeStatus(store.state, "ABCDEFGH23")).toBe("assigned");
});
