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
import { alice, carol, renderInShell, seedUsers, inSession } from "./moveTestKit";

// A counted stack: its page, its counts, and turning a single item into one (FR-INV-34, FR-INV-36).
let store: Store;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice, carol]);
  // A session is running, so a check-out does not stop to ask the event (FR-OUT-05).
  await inSession(store);
});

afterEach(() => unsaved.cancel());

const user = userEvent.setup();
const fact = (label: string) => (screen.getByText(label).nextElementSibling as HTMLElement).textContent;
const shares = () =>
  [...screen.getByText("Cleaning").nextElementSibling!.querySelectorAll(".cleaning-share > span")].map(
    (x) => x.textContent,
  );

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

  // Recount: prefilled with what is in now, and the reason is optional.
  await user.click(screen.getByRole("button", { name: "Recount" }));
  expect(screen.getByLabelText("How many")).toHaveValue(20);
  expect(screen.getByRole("button", { name: "Recount" })).toBeEnabled();
  await user.clear(screen.getByLabelText("How many"));
  await user.type(screen.getByLabelText("How many"), "18");
  await user.type(screen.getByLabelText("Why (optional)"), "counted on the shelf");
  await user.click(screen.getByRole("button", { name: "Recount" }));
  await waitFor(() => expect(inv.item(store.state, bowls)?.pool_in).toBe(18));
  expect(await screen.findByText(/Recounted to 18 by Alice: counted on the shelf/)).toBeInTheDocument();
});

test("a recount needs no reason, and its history line has no colon (FR-INV-35)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  await user.click(screen.getByRole("button", { name: "Recount" }));
  await user.clear(screen.getByLabelText("How many"));
  await user.type(screen.getByLabelText("How many"), "17");
  await user.click(screen.getByRole("button", { name: "Recount" }));
  await waitFor(() => expect(inv.item(store.state, bowls)?.pool_in).toBe(17));
  const line = await screen.findByText(/Recounted to 17 by Alice · /);
  expect(line.textContent).not.toMatch(/null|by Alice:/);
});

test("a blank count cannot be recounted", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  await user.click(screen.getByRole("button", { name: "Recount" }));
  await user.clear(screen.getByLabelText("How many"));
  expect(screen.getByRole("button", { name: "Recount" })).toBeDisabled();
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

test("All checks out everything that is in (FR-OUT-42)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 12);
  await mv.checkOutPool(store, bowls, { count: 1 });
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  await user.click(screen.getByRole("button", { name: "Check out" }));
  expect(screen.getByLabelText("How many")).toHaveValue(1);
  await user.click(screen.getByRole("button", { name: "All 11" }));
  await waitFor(() => expect(inv.item(store.state, bowls)?.pool_in).toBe(0));
  expect(inv.item(store.state, bowls)?.pool_out).toEqual({ alice: 12 });
  expect(await screen.findByText("Checked out 11 · Bowls")).toBeInTheDocument();
});

test("All ignores a blank count field (FR-OUT-42)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 12);
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  await user.click(screen.getByRole("button", { name: "Check out" }));
  await user.clear(screen.getByLabelText("How many"));
  await user.click(screen.getByRole("button", { name: "All 12" }));
  await waitFor(() => expect(inv.item(store.state, bowls)?.pool_out).toEqual({ alice: 12 }));
});

test("All is offered only for a check-out of more than one (FR-OUT-42)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 2);
  await mv.checkOutPool(store, bowls, { count: 1 });
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  await user.click(screen.getByRole("button", { name: "Check out" }));
  expect(screen.queryByRole("button", { name: /^All/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Return" }));
  expect(screen.queryByRole("button", { name: /^All/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Recount" }));
  expect(screen.queryByRole("button", { name: /^All/ })).not.toBeInTheDocument();
});

test("All is not offered when none are in (FR-OUT-42)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 2);
  await mv.checkOutPool(store, bowls, { count: 2 });
  navigate(`/items/${bowls}`);
  renderInShell(<ItemPage store={store} id={bowls} />);

  await user.click(screen.getByRole("button", { name: "Check out" }));
  expect(screen.queryByRole("button", { name: /^All/ })).not.toBeInTheDocument();
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
  navigate(`/items/${stove}?edit=1`);
  renderInShell(<ItemPage store={store} id={stove} />);

  expect(screen.queryByRole("button", { name: "Make this a counted stack…" })).not.toBeInTheDocument();
  await user.click(screen.getByLabelText("We have several of these"));
  await user.click(screen.getByLabelText("A stack we count"));
  const quantity = screen.getByLabelText("How many");
  await user.clear(quantity);
  await user.type(quantity, "12");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(inv.item(store.state, stove)?.merged_into).toBeFalsy();
  await user.click(screen.getByRole("button", { name: "Yes, make it several" }));

  await waitFor(() => expect(location.pathname).not.toBe(`/items/${stove}`));
  const poolId = location.pathname.split("/").at(-1)!;
  expect(inv.item(store.state, poolId)).toMatchObject({ name: "Stove", pool: true, pool_in: 12 });
  expect(inv.item(store.state, stove)?.merged_into).toBe(poolId);
});

test("a single item's code comes along when it becomes a counted stack (FR-TAG-15)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await printCodes(store, ["ABCDEFGH23"]);
  await act.bindCode(store, "ABCDEFGH23", stove);
  navigate(`/items/${stove}?edit=1`);
  renderInShell(<ItemPage store={store} id={stove} />);

  await user.click(screen.getByLabelText("We have several of these"));
  await user.click(screen.getByLabelText("A stack we count"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await user.click(screen.getByRole("button", { name: "Yes, make it several" }));

  await waitFor(() => expect(location.pathname).not.toBe(`/items/${stove}`));
  const poolId = location.pathname.split("/").at(-1)!;
  expect(inv.currentCode(store.state, poolId)?.id).toBe("ABCDEFGH23");
  expect(inv.codeStatus(store.state, "ABCDEFGH23")).toBe("assigned");
});

test("gear that is out cannot become a counted stack until it is back (FR-INV-34)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await mv.checkOut(store, stove, { event: "Fall Camp" });
  navigate(`/items/${stove}?edit=1`);
  renderInShell(<ItemPage store={store} id={stove} />);

  await user.click(screen.getByLabelText("We have several of these"));
  expect(screen.getByLabelText("A stack we count")).toBeDisabled();
  expect(screen.getByLabelText("Labelled one by one")).toBeChecked();
  expect(screen.getByLabelText("This one’s number")).toBeInTheDocument();
});

test("retired gear cannot become a counted stack (FR-INV-34)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await act.retireItem(store, stove);
  navigate(`/items/${stove}?edit=1`);
  renderInShell(<ItemPage store={store} id={stove} />);

  await user.click(screen.getByLabelText("We have several of these"));
  expect(screen.getByLabelText("A stack we count")).toBeDisabled();
  await expect(act.makePool(store, stove, 3)).rejects.toThrow("retired");
});

test("a check-out synced while Save waits to be confirmed asks again (FR-INV-34)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  navigate(`/items/${stove}?edit=1`);
  renderInShell(<ItemPage store={store} id={stove} />);

  await user.click(screen.getByLabelText("We have several of these"));
  await user.click(screen.getByLabelText("A stack we count"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("button", { name: "Yes, make it several" })).toBeInTheDocument();
  await mv.checkOut(store, stove, { event: "Fall Camp" });

  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument());
  expect(inv.generics(store.state)).toEqual([]);
});

test("a share of a stack goes home with a family, and a return names whose it is (FR-OUT-46, FR-OUT-47)", async () => {
  const bags = await act.createPool(store, { name: "Bags" }, 20);
  await mv.checkOutPool(store, bags, { count: 10, event: "Camp" });
  navigate(`/items/${bags}`);
  renderInShell(<ItemPage store={store} id={bags} />);

  for (const [n, name] of [
    ["4", "Smith"],
    ["2", "Jones"],
  ] as const) {
    await user.click(screen.getByRole("button", { name: "Send home to clean" }));
    const count = screen.getByLabelText("How many");
    await user.clear(count);
    await user.type(count, n);
    const send = screen.getByRole("button", { name: "Send home" });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText("Taken home by"), name);
    await user.click(send);
    await waitFor(() => expect(screen.queryByLabelText("Taken home by")).not.toBeInTheDocument());
  }
  expect(shares()).toEqual(["Jones · 2", "Smith · 4"]);

  await user.click(screen.getByRole("button", { name: "Return" }));
  await user.selectOptions(screen.getByLabelText("Returned from"), "Jones · 2");
  expect(screen.getByLabelText("How many")).toHaveValue(2);
  await user.click(screen.getAllByRole("button", { name: "Return" })[0]!);
  await waitFor(() => expect(shares()).toEqual(["Smith · 4"]));
});

test("part of a family's share comes back to the Scouter from the stack's page (FR-OUT-51)", async () => {
  const bags = await act.createPool(store, { name: "Bags" }, 20);
  await mv.checkOutPool(store, bags, { count: 6, event: "Camp" });
  await mv.sendHomeFromPool(store, bags, { count: 4, cleaner: "Smith" });
  await mv.sendHomeFromPool(store, bags, { count: 2, cleaner: "Jones" });
  navigate(`/items/${bags}`);
  renderInShell(<ItemPage store={store} id={bags} />);

  await user.click(screen.getByRole("button", { name: "Back from cleaning" }));
  await user.selectOptions(screen.getByLabelText("Back from"), "Smith · 4");
  const count = screen.getByLabelText("How many");
  await user.clear(count);
  await user.type(count, "3");
  await user.click(screen.getAllByRole("button", { name: "Back from cleaning" })[0]!);

  await waitFor(() => expect(shares()).toEqual(["Jones · 2", "Smith · 1"]));
});

test("a family's name is corrected on the stack's page, for every Scouter's lots (FR-OUT-50)", async () => {
  const bags = await act.createPool(store, { name: "Bags" }, 20);
  await mv.checkOutPool(store, bags, { count: 4, event: "Camp" });
  await mv.checkOutPool(store, bags, { count: 2, event: "Camp" });
  await mv.sendHomeFromPool(store, bags, { count: 5, cleaner: "Smth" });
  await store.setMeta({ user: carol });
  await mv.checkOutPool(store, bags, { count: 3, event: "Camp" });
  await mv.sendHomeFromPool(store, bags, { count: 3, cleaner: " smth" });
  await store.setMeta({ user: alice });
  navigate(`/items/${bags}`);
  renderInShell(<ItemPage store={store} id={bags} />);

  expect(shares()).toEqual(["Smth · 8"]);
  await user.click(screen.getByRole("button", { name: "Change name" }));
  const name = screen.getByLabelText("Taken home by");
  await user.clear(name);
  await user.type(name, "Smith");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(shares()).toEqual(["Smith · 8"]));
  const names = inv.poolLots(inv.item(store.state, bags)!).flatMap((o) => o.lots.map((l) => l.cleaner));
  expect(names.filter(Boolean)).toEqual(["Smith", "Smith", "Smith"]);
  expect(store.pending.filter((e) => e.type === "cleaner_corrected")).toHaveLength(2);
});
