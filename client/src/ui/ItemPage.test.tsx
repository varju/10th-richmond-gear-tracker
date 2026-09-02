import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { item } from "../lib/inventory";
import * as mv from "../lib/movement";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { ItemPage } from "./ItemPage";
import { alice, carol, renderInShell, seedUsers } from "./moveTestKit";

// Movement from the item page, for gear with no sticker (FR-OUT-02, FR-OUT-07), and the item's history.
let store: Store;
let tent: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice, carol]);
  tent = await act.createItem(store, { name: "Tent 1" });
  navigate(`/items/${tent}`);
});

const user = userEvent.setup();
const actions = () => screen.getByRole("button", { name: "Replace code" }).closest(".actions")!;
const section = (name: string) => screen.getByRole("heading", { name }).nextElementSibling!;

test("Check out from the page records the session event and syncs (FR-OUT-02)", async () => {
  await store.setMeta({ session_event: "Spring camp" });
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(actions()).toHaveTextContent("Event: Spring camp");

  await user.click(screen.getByRole("button", { name: "Check out" }));
  expect(await screen.findByText("Checked out · Tent 1")).toHaveAttribute("role", "status");
  expect(store.pending.filter((e) => e.type === "checked_out").map((e) => e.payload)).toEqual([
    { holder_id: "alice", event: "Spring camp" },
  ]);
  expect(screen.getByText("out · Alice")).toBeInTheDocument();

  // Now it is out and mine: Check in, no transfer.
  expect(screen.getByRole("button", { name: "Check in" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Transfer to me" })).not.toBeInTheDocument();
});

test("someone else's gear can be checked in or transferred (FR-OUT-07, FR-OUT-12)", async () => {
  await mv.checkOut(store, tent, { event: "Spring camp" });
  await store.setMeta({ user: carol });
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.getByRole("button", { name: "Transfer to me" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Check in" }));
  expect(await screen.findByText("Checked in · Tent 1")).toHaveAttribute("role", "status");
  expect(item(store.state, tent)?.status).toBe("in");
});

test("a retired item has no movement buttons", async () => {
  await act.retireItem(store, tent);
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check in" })).not.toBeInTheDocument();
  expect(screen.getByText("Retired. Cannot be checked out.")).toBeInTheDocument();
});

test("history lists movements newest first, with their notes (FR-INV-09)", async () => {
  await mv.checkOut(store, tent, { event: "Spring camp", note: "to a patrol" });
  await mv.checkIn(store, tent, { note: "muddy" });
  await store.setMeta({ user: carol });
  await mv.checkOut(store, tent);
  await store.setMeta({ user: alice });
  await mv.transfer(store, tent, { event: "Cub camp" });
  renderInShell(<ItemPage store={store} id={tent} />);

  const rows = [...section("History").querySelectorAll(":scope > li")];
  expect(rows.map((r) => r.textContent)).toEqual([
    "Transferred to Alice for Cub camp · 2025-09-01",
    "Checked out by Carol · 2025-09-01",
    "Checked in by Alice · 2025-09-01muddyAlice · 2025-09-01Edit",
    "Checked out by Alice for Spring camp · 2025-09-01to a patrolAlice · 2025-09-01Edit",
  ]);
  expect(screen.getByText(/last 90 days/)).toBeInTheDocument();
});

test("a note is corrected in place and the correction is appended (FR-OUT-16)", async () => {
  const note = await mv.addNote(store, tent, "handed to a Scout");
  renderInShell(<ItemPage store={store} id={tent} />);
  const notes = section("Notes") as HTMLElement;
  expect(notes).toHaveTextContent("handed to a Scout");

  await user.click(within(notes).getByRole("button", { name: "Edit" }));
  await user.clear(screen.getByLabelText("Note text"));
  await user.type(screen.getByLabelText("Note text"), "handed to a Scout for the weekend");
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("handed to a Scout for the weekend")).toBeInTheDocument();
  expect(store.pending.at(-1)).toMatchObject({
    type: "note_corrected",
    payload: { note_id: note.id, text: "handed to a Scout for the weekend" },
  });
});

test("an item-level note is added from the page", async () => {
  renderInShell(<ItemPage store={store} id={tent} />);
  // The actions area has its own "Add note", for a note on the movement.
  const main = document.querySelector("main") as HTMLElement;
  await user.click(within(main).getByRole("button", { name: "Add note" }));
  await user.type(screen.getByLabelText("New note"), "pole repaired");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("pole repaired")).toBeInTheDocument();
  expect(store.pending.at(-1)).toMatchObject({
    type: "note_added",
    payload: { text: "pole repaired" },
  });
});

test("?edit=1 opens the form straight away, and saving drops it from the URL", async () => {
  navigate(`/items/${tent}?edit=1`);
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Edit item");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Item");
  expect(location.search).toBe("");
});
