import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as rep from "../lib/repairs";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore } from "./codeTestKit";
import { alice, carol, renderInShell, seedUsers } from "./moveTestKit";
import { RepairPage } from "./RepairPage";
import { Repairs } from "./Repairs";

// One ticket: its state, its comments, and the way back to the item (S-REP-03).
let store: Store;
let tent: string;
let ticket: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice, carol]);
  tent = await act.createItem(store, { name: "Tent 1" });
  ticket = await rep.raiseTicket(store, tent, "zipper broken");
  navigate(`/repairs/${ticket}`);
});

afterEach(() => unsaved.cancel());

const user = userEvent.setup();

test("the ticket shows what is wrong, where it stands, and who raised it", async () => {
  renderInShell(<RepairPage store={store} id={ticket} />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Repair");
  expect(screen.getByText("zipper broken")).toBeInTheDocument();
  expect(screen.getByText("Open")).toBeInTheDocument();
  expect(screen.getByText("Raised by Alice · 2025-09-01")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Tent 1" }));
  expect(location.pathname).toBe(`/items/${tent}`);
});

test("one button per other state moves the ticket there (FR-REP-03)", async () => {
  renderInShell(<RepairPage store={store} id={ticket} />);
  const actions = screen.getByRole("button", { name: "Resolved" }).closest(".actions")!;
  expect([...actions.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
    "In progress",
    "Resolved",
    "Won't fix",
  ]);

  await user.click(screen.getByRole("button", { name: "In progress" }));
  expect(await screen.findByText("In progress", { selector: "p" })).toBeInTheDocument();
  expect([...actions.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Open", "Resolved", "Won't fix"]);
  expect(store.pending.at(-1)).toMatchObject({
    entity_type: "repair",
    type: "field_changed",
    payload: { field: "state", value: "in_progress", old: "open" },
  });
});

test("comments are added and edited through the repair (FR-REP-06)", async () => {
  renderInShell(<RepairPage store={store} id={ticket} />);
  await user.click(screen.getByRole("button", { name: "Add note" }));
  await user.type(screen.getByLabelText("New note"), "slider ordered, $8");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("slider ordered, $8")).toBeInTheDocument();
  expect(store.pending.at(-1)).toMatchObject({
    entity_type: "repair",
    entity_id: ticket,
    type: "note_added",
    payload: { text: "slider ordered, $8" },
  });

  await store.setMeta({ user: carol });
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.clear(screen.getByLabelText("Note text"));
  await user.type(screen.getByLabelText("Note text"), "slider fitted");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("slider fitted")).toBeInTheDocument();
  expect(screen.getByText("Alice · 2025-09-01")).toBeInTheDocument();
  expect(store.pending.at(-1)).toMatchObject({ type: "note_corrected", entity_id: ticket });
});

test("a ticket this phone has not seen says so", () => {
  renderInShell(<RepairPage store={store} id="nope" />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Not found");
});

test("the repairs list holds what is still open, newest first, and opens a ticket", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  const later = await rep.raiseTicket(store, stove, "valve leaks");
  const done = await rep.raiseTicket(store, tent, "pole bent");
  await rep.setRepairState(store, done, "resolved");
  await rep.setRepairState(store, later, "in_progress");
  navigate("/repairs");
  renderInShell(<Repairs store={store} />);

  const rows = screen.getAllByRole("listitem").map((li) => within(li).getByRole("button").textContent);
  expect(rows).toEqual(["StoveIn progress · valve leaks", "Tent 1Open · zipper broken"]);
  expect(screen.getByText("2 tickets")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /Stove/ }));
  expect(location.pathname).toBe(`/repairs/${later}`);
});

test("nothing open says so", async () => {
  await rep.setRepairState(store, ticket, "wont_fix");
  renderInShell(<Repairs store={store} />);
  expect(screen.getByText("Nothing needs repair.")).toBeInTheDocument();
});
