import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as inv from "../lib/inventory";
import * as mv from "../lib/movement";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore } from "./codeTestKit";
import { ItemPage } from "./ItemPage";
import { alice, renderInShell, seedUsers } from "./moveTestKit";
import { NewUnit } from "./NewItem";

// One name over several things: the page, its units, and turning a single item into one (FR-INV-21).
let store: Store;
let cold: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
  cold = await act.createLocation(store, "Cold locker");
});

afterEach(() => unsaved.cancel());

const user = userEvent.setup();
const show = (id: string) => inv.displayName(store.state, inv.item(store.state, id)!);
const section = (name: string) => screen.getByRole("heading", { name }).nextElementSibling as HTMLElement;

test("a single item becomes several: a new name above it, and it becomes #1 (FR-INV-26)", async () => {
  const tent = await act.createItem(store, { name: "4-person tent", home_location_id: cold });
  await mv.checkOut(store, tent, { event: "Fall Camp" });
  navigate(`/items/${tent}?edit=1`);
  renderInShell(<ItemPage store={store} id={tent} />);

  await user.click(screen.getByLabelText("We have several of these"));
  expect(screen.getByRole("note")).toHaveTextContent("becomes a name for several, and this one becomes #1");
  // One tap asks; the second one does it.
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(inv.generics(store.state)).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Yes, make it several" }));

  await waitFor(() => expect(show(tent)).toBe("4-person tent #1"));
  const generic = inv.generics(store.state)[0]!;
  expect(generic).toMatchObject({ name: "4-person tent", home_location_id: cold });
  // Nothing it did is rewritten: it is still out under the camp.
  expect(inv.item(store.state, tent)).toMatchObject({ status: "out", parent_id: generic.id, number: 1 });
});

test("a generic lists its units, adds one, and is retired only once they all are (FR-INV-27)", async () => {
  const tents = await act.createGeneric(store, { name: "4-person tent", home_location_id: cold });
  const one = await act.addUnit(store, tents);
  navigate(`/items/${tents}`);
  renderInShell(<ItemPage store={store} id={tents} />);
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("4-person tent");
  expect(screen.getByText("1 unit · 1 in")).toBeInTheDocument();
  expect(within(section("Units")).getByRole("button", { name: /4-person tent #1/ })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Add a unit" }));
  await waitFor(() => expect(inv.unitsOf(store.state, tents)).toHaveLength(2));
  expect(location.pathname).toBe(`/items/${inv.unitsOf(store.state, tents)[1]!.id}`);

  cleanup();
  navigate(`/items/${tents}?edit=1`);
  renderInShell(<ItemPage store={store} id={tents} />);
  await user.click(screen.getByLabelText("Retired"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("retire its units first");
  expect(inv.item(store.state, tents)?.retired).toBeFalsy();

  for (const u of inv.unitsOf(store.state, tents)) await act.retireItem(store, u.id);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(inv.item(store.state, tents)?.retired).toBe(true));
  expect(one).toBeDefined();
});

test("a unit points at its generic and can be filed under another (FR-INV-28)", async () => {
  const tents = await act.createGeneric(store, { name: "4-person tent", home_location_id: cold });
  const tarps = await act.createGeneric(store, { name: "3x3 tarp" });
  await act.addUnit(store, tarps);
  const unit = await act.addUnit(store, tents);
  navigate(`/items/${unit}`);
  renderInShell(<ItemPage store={store} id={unit} />);
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("4-person tent #1");
  expect(screen.getByRole("button", { name: "4-person tent" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Move to another generic…" }));
  await user.click(screen.getByRole("button", { name: /3x3 tarp/ }));
  // #1 was taken under the tarps, so it is bumped to the next free number.
  await waitFor(() => expect(show(unit)).toBe("3x3 tarp #2"));
  expect(inv.unitsOf(store.state, tents)).toEqual([]);
});

test("a new unit is offered the next free number, and takes the generic's home (FR-INV-22, FR-INV-29)", async () => {
  const tents = await act.createGeneric(store, { name: "4-person tent", home_location_id: cold });
  await act.addUnit(store, tents);
  navigate(`/items/new?parent=${tents}`);
  renderInShell(<NewUnit store={store} parent={tents} code={null} />);
  expect(screen.getByLabelText("Number")).toHaveValue(2);

  // The gear may already have a number painted on it, and it may be one we used.
  await user.clear(screen.getByLabelText("Number"));
  await user.type(screen.getByLabelText("Number"), "1");
  expect(screen.getByText("#1 is already used here. Pick another.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await user.clear(screen.getByLabelText("Number"));
  await user.type(screen.getByLabelText("Number"), "7");
  await user.type(screen.getByLabelText("Nickname (optional)"), "patched fly");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(inv.unitsOf(store.state, tents)).toHaveLength(2));
  const made = inv.unitsOf(store.state, tents)[1]!;
  expect(inv.displayName(store.state, made)).toBe("4-person tent #7 (patched fly)");
  expect(made).toMatchObject({ home_location_id: cold });
});
