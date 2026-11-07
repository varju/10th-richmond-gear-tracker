import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as inv from "../lib/inventory";
import { navigate } from "../lib/router";
import { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore } from "./codeTestKit";
import { ItemPage } from "./ItemPage";
import { alice, renderInShell, seedUsers } from "./moveTestKit";
import { NewItem } from "./NewItem";

// Duplicate on an item page opens New item filled from it (FR-INV-55).
let store: Store;
let cold: string;
let camping: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
  cold = await act.createLocation(store, "Cold locker");
  camping = await act.createCategory(store, "Camping");
});

afterEach(() => {
  unsaved.cancel();
  cleanup();
});

const user = userEvent.setup();

async function tent() {
  const id = await act.createItem(store, {
    name: "Tent",
    description: "Green fly",
    home_location_id: cold,
    sub_location: "Shelf 2",
    purchase_date: "2024-05-01",
    category_ids: [camping],
  });
  await act.bindCode(store, "AAAAAAAAAA", id);
  return id;
}

test("an item page offers Duplicate, which opens a copy of its details", async () => {
  const id = await tent();
  navigate(`/items/${id}`);
  renderInShell(<ItemPage store={store} id={id} />);
  await user.click(screen.getByRole("button", { name: "Duplicate…" }));
  expect(location.pathname + location.search).toBe(`/items/new?from=${id}`);
});

test("the copy has the name, categories, home, shelf, description and purchase date", async () => {
  const id = await tent();
  renderInShell(<NewItem store={store} code={null} from={id} />);
  expect(screen.getByLabelText("Name")).toHaveValue("Tent");
  expect(screen.getByLabelText("Camping")).toBeChecked();
  expect(screen.getByLabelText("Home location")).toHaveValue(cold);
  expect(screen.getByLabelText("Shelf")).toHaveValue("Shelf 2");
  expect(screen.getByLabelText("Description")).toHaveValue("Green fly");
  expect(screen.getByLabelText("Bought on")).toHaveValue("2024-05-01");
  expect(screen.getByLabelText("We have several of these")).not.toBeChecked();
  // Nothing is saved until Save, and the copy counts as a draft.
  expect(inv.items(store.state)).toHaveLength(1);
  expect(unsaved.any).toBe(true);
});

test("Save makes a separate item with no code", async () => {
  const id = await tent();
  navigate(`/items/new?from=${id}`);
  renderInShell(<NewItem store={store} code={null} from={id} />);
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "Tent, big");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(inv.items(store.state)).toHaveLength(2));
  const copy = inv.items(store.state).find((i) => i.id !== id)!;
  expect(copy).toMatchObject({ name: "Tent, big", home_location_id: cold, sub_location: "Shelf 2" });
  expect(inv.currentCode(store.state, copy.id)).toBeUndefined();
  expect(inv.currentCode(store.state, id)?.id).toBe("AAAAAAAAAA");
  expect(inv.item(store.state, id)?.name).toBe("Tent");
});

test("a unit has no Duplicate", async () => {
  const generic = await act.createGeneric(store, { name: "Cot" });
  const unit = await act.createUnit(store, { parent_id: generic, number: "1" });
  renderInShell(<ItemPage store={store} id={unit} />);
  expect(screen.queryByRole("button", { name: "Duplicate…" })).not.toBeInTheDocument();
});

test("a generic copies as a generic with no units", async () => {
  const generic = await act.createGeneric(store, { name: "Cot", home_location_id: cold });
  await act.createUnit(store, { parent_id: generic, number: "1" });
  renderInShell(<NewItem store={store} code={null} from={generic} />);
  expect(screen.getByLabelText("We have several of these")).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(inv.items(store.state).filter((i) => i.generic)).toHaveLength(2));
  const copy = inv.items(store.state).find((i) => i.generic && i.id !== generic)!;
  expect(copy.name).toBe("Cot");
  expect(inv.items(store.state).filter((i) => i.parent_id === copy.id)).toHaveLength(0);
});

test("a pool copies as a pool, and Save waits for a count", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  renderInShell(<NewItem store={store} code={null} from={bowls} />);
  expect(screen.getByLabelText("A stack we count")).toBeChecked();
  const count = screen.getByLabelText("How many");
  expect(count).toHaveValue(null);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.type(count, "12");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(inv.items(store.state).filter((i) => i.pool)).toHaveLength(2));
});

test("a generic's page and a pool's page offer Duplicate too", async () => {
  const generic = await act.createGeneric(store, { name: "Cot" });
  const bowls = await act.createPool(store, { name: "Bowls" }, 20);
  for (const id of [generic, bowls]) {
    navigate(`/items/${id}`);
    renderInShell(<ItemPage store={store} id={id} />);
    await user.click(screen.getByRole("button", { name: "Duplicate…" }));
    expect(location.pathname + location.search).toBe(`/items/new?from=${id}`);
    cleanup();
  }
});

test("saving a duplicate leaves the remembered categories alone", async () => {
  const id = await tent();
  await store.setMeta({ last_category_ids: undefined });
  renderInShell(<NewItem store={store} code={null} from={id} />);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(inv.items(store.state)).toHaveLength(2));
  expect(store.meta.last_category_ids).toBeUndefined();
});

test("an unknown source opens a blank New item", async () => {
  renderInShell(<NewItem store={store} code={null} from="nope" />);
  expect(screen.getByLabelText("Name")).toHaveValue("");
});
