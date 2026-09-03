import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { DAY_MS } from "../lib/clock";
import { currentCode, generics, item, nameOf, unitsOf } from "../lib/inventory";
import * as mv from "../lib/movement";
import * as rep from "../lib/repairs";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore } from "./codeTestKit";
import { ItemPage } from "./ItemPage";
import { LeaveDialog } from "./LeaveDialog";
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

afterEach(() => unsaved.cancel());

const user = userEvent.setup();
const dialog = () => screen.findByRole("alertdialog");
const withDialog = () =>
  renderInShell(
    <>
      <ItemPage store={store} id={tent} />
      <LeaveDialog />
    </>,
  );

const actions = () => screen.getByRole("button", { name: "Add QR code" }).closest(".actions")!;
// History and Changes fold their heading into a <summary>; its count makes the name inexact.
const section = (name: string) => {
  const heading = screen.getByRole("heading", { name: new RegExp(`^${name}(?: ·|$)`) });
  return (heading.closest("summary") ?? heading).nextElementSibling!;
};

test("Check out from the page records the session event and syncs (FR-OUT-02)", async () => {
  await store.setMeta({ session_event: "Spring camp" });
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(actions()).toHaveTextContent("Event: Spring camp");

  await user.click(screen.getByRole("button", { name: "Check out" }));
  expect(await screen.findByText("Checked out · Tent 1")).toHaveAttribute("role", "status");
  expect(store.pending.filter((e) => e.type === "checked_out").map((e) => e.payload)).toEqual([
    { holder_id: "alice", event: "Spring camp" },
  ]);
  expect(screen.getByText("Out · Alice")).toBeInTheDocument();

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

test("gear out longer than the group's period is flagged (FR-OUT-14)", async () => {
  await act.setGroup(store, { name: "10th", overdue_days: 1 });
  await mv.checkOut(store, tent, {});
  const since = item(store.state, tent)!.since!;
  renderInShell(<ItemPage store={store} id={tent} />, () => since + 2 * DAY_MS);
  expect(screen.getByText("Out · Alice · Overdue")).toBeInTheDocument();
});

test("a retired item has no movement buttons", async () => {
  await act.retireItem(store, tent);
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check in" })).not.toBeInTheDocument();
  expect(screen.getByText("Retired. Cannot be checked out.")).toBeInTheDocument();
});

test("history lists movements and notes together, newest first (FR-INV-09)", async () => {
  await mv.checkOut(store, tent, { event: "Spring camp", note: "to a patrol" });
  await mv.checkIn(store, tent, { note: "muddy" });
  await store.setMeta({ user: carol });
  await mv.checkOut(store, tent);
  await store.setMeta({ user: alice });
  await mv.transfer(store, tent, { event: "Cub camp" });
  await mv.addNote(store, tent, "pole repaired");
  renderInShell(<ItemPage store={store} id={tent} />);

  const rows = [...section("History").querySelectorAll(":scope > li")];
  expect(rows.map((r) => r.textContent)).toEqual([
    "pole repairedAlice · 2025-08-31 17:00EditDelete",
    "Transferred to Alice for Cub camp · 2025-08-31 17:00",
    "Checked out by Carol · 2025-08-31 17:00",
    "Checked in by Alice · 2025-08-31 17:00muddyAlice · 2025-08-31 17:00EditDelete",
    "Checked out by Alice for Spring camp · 2025-08-31 17:00to a patrolAlice · 2025-08-31 17:00EditDelete",
  ]);
  // No shell api here, so this is what the device knows: said once under History, once under Changes.
  expect(screen.getAllByText("Offline: what this device knows, the last 90 days.")).toHaveLength(2);
});

test("a note is corrected in place and the correction is appended (FR-OUT-16)", async () => {
  const note = await mv.addNote(store, tent, "handed to a Scout");
  renderInShell(<ItemPage store={store} id={tent} />);
  await user.click(screen.getByText(/^History/));
  const timeline = section("History") as HTMLElement;
  expect(timeline).toHaveTextContent("handed to a Scout");

  await user.click(within(timeline).getByRole("button", { name: "Edit" }));
  await user.clear(screen.getByLabelText("Note text"));
  await user.type(screen.getByLabelText("Note text"), "handed to a Scout for the weekend");
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("handed to a Scout for the weekend")).toBeInTheDocument();
  expect(store.pending.at(-1)).toMatchObject({
    type: "note_corrected",
    payload: { note_id: note.id, text: "handed to a Scout for the weekend" },
  });
});

test("a note is deleted after a second tap, and the log keeps it (FR-OUT-21)", async () => {
  const note = await mv.addNote(store, tent, "handed to a Scout");
  renderInShell(<ItemPage store={store} id={tent} />);
  await user.click(screen.getByText(/^History/));
  await user.click(screen.getByRole("button", { name: "Delete “handed to a Scout”" }));
  expect(screen.getByRole("button", { name: "Really delete “handed to a Scout”?" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Really delete “handed to a Scout”?" }));
  await waitFor(() => expect(screen.queryByText("handed to a Scout")).not.toBeInTheDocument());
  expect(store.pending.at(-1)).toMatchObject({ type: "note_deleted", payload: { note_id: note.id } });
});

test("an item-level note is added from the page", async () => {
  renderInShell(<ItemPage store={store} id={tent} />);
  await user.click(screen.getByText(/^History/));
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

test("a fault reported from the page raises a ticket, which flags the item (FR-REP-01, FR-REP-05)", async () => {
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  // The actions area has its own "Report a problem", for one that rides on a move.
  const main = document.querySelector("main") as HTMLElement;
  await user.click(within(main).getByRole("button", { name: "Report a problem" }));
  await user.type(screen.getByLabelText("Problem"), "zipper broken");
  await user.click(screen.getByRole("button", { name: "Save" }));

  // Once at the top of the page, once beside the movement buttons (FR-REP-05).
  const notes = await screen.findAllByRole("note");
  expect(notes.map((n) => n.textContent)).toEqual(["Needs repair · zipper broken", "Needs repair · zipper broken"]);
  expect(store.pending.at(-1)).toMatchObject({
    entity_type: "repair",
    type: "created",
    payload: { item_id: tent, description: "zipper broken" },
  });
  // The ticket is listed on the item, and opens.
  await user.click(screen.getByRole("button", { name: /Open · zipper broken/ }));
  expect(location.pathname).toMatch(/^\/repairs\//);
});

test("closed tickets stay on the item, after the open ones (FR-REP-04)", async () => {
  const old = await rep.raiseTicket(store, tent, "pole bent");
  await rep.setRepairState(store, old, "resolved");
  await rep.raiseTicket(store, tent, "zipper broken");
  renderInShell(<ItemPage store={store} id={tent} />);
  const rows = [...(section("Repairs") as HTMLElement).querySelectorAll("li")].map((li) => li.textContent);
  expect(rows).toEqual(["Open · zipper broken · 2025-09-01", "Resolved · pole bent · 2025-09-01"]);
  expect(screen.getAllByRole("note").map((n) => n.textContent)).toEqual([
    "Needs repair · zipper broken",
    "Needs repair · zipper broken",
  ]);
});

test("marking an item missing takes two taps and flags it without moving it (FR-INV-19)", async () => {
  await mv.checkOut(store, tent);
  renderInShell(<ItemPage store={store} id={tent} />);
  await user.click(screen.getByRole("button", { name: "Mark missing" }));
  expect(item(store.state, tent)?.missing).toBeUndefined();
  await user.click(screen.getByRole("button", { name: "Really missing?" }));

  expect(await screen.findByText("Missing", { selector: ".badge" })).toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("Missing. Scanning it or checking it in clears this.");
  expect(screen.queryByRole("button", { name: "Mark missing" })).not.toBeInTheDocument();
  expect(item(store.state, tent)).toMatchObject({ status: "out", missing: true });
  expect(store.pending.at(-1)).toMatchObject({
    type: "field_changed",
    payload: { field: "missing", value: true, old: null },
  });

  // Checking it in clears the mark (FR-INV-19).
  await user.click(screen.getByRole("button", { name: "Check in" }));
  await waitFor(() => expect(screen.queryByRole("note")).not.toBeInTheDocument());
  expect(item(store.state, tent)).toMatchObject({ status: "in", missing: false });
});

test("the QR button offers to add a code or replace the one it has", async () => {
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.getByRole("button", { name: "Add QR code" })).toBeInTheDocument();

  await act.bindCode(store, "AAAAAAAAAA", tent);
  expect(await screen.findByRole("button", { name: "Replace QR code" })).toBeInTheDocument();
});

test("?edit=1 opens the form straight away, and saving drops it from the URL", async () => {
  navigate(`/items/${tent}?edit=1`);
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Edit item");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Item");
  expect(location.search).toBe("");
});

test("ticking two categories on the edit form records both and the page shows them (FR-SET-07)", async () => {
  const camp = await act.createCategory(store, "Camp kitchen");
  const cold = await act.createCategory(store, "Cold weather");
  renderInShell(<ItemPage store={store} id={tent} />);
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.click(screen.getByLabelText("Camp kitchen"));
  await user.click(screen.getByLabelText("Cold weather"));
  await user.click(screen.getByRole("button", { name: "Save" }));

  const categoryEvents = () =>
    store.pending.filter((e) => e.type === "field_changed" && e.payload.field === "category_ids").map((e) => e.payload);
  await waitFor(() => expect(categoryEvents()).toEqual([{ field: "category_ids", value: [camp, cold], old: [] }]));
  expect(await screen.findByText("Categories")).toBeInTheDocument();
  expect(screen.getByText("Camp kitchen, Cold weather")).toBeInTheDocument();
});

test("cancelling an edit with changes asks; Save keeps them", async () => {
  withDialog();
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Tent 1" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.type(screen.getByLabelText("Name"), " (green)");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(within(await dialog()).getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("heading", { name: "Tent 1 (green)" })).toBeInTheDocument();
  expect(item(store.state, tent)?.name).toBe("Tent 1 (green)");
});

test("cancelling an edit with changes asks; Discard drops them", async () => {
  withDialog();
  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.type(screen.getByLabelText("Name"), " (green)");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(within(await dialog()).getByRole("button", { name: "Discard" }));
  expect(await screen.findByRole("heading", { name: "Tent 1" })).toBeInTheDocument();
  expect(item(store.state, tent)?.name).toBe("Tent 1");
});

test("a half-typed note asks on Back; Save records it", async () => {
  withDialog();
  await user.click(screen.getByText(/^History/));
  // The first "Add note" is the item's; the move buttons have their own.
  await user.click(screen.getAllByRole("button", { name: "Add note" })[0]!);
  await user.type(screen.getByLabelText("New note"), "pole bent");
  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(within(await dialog()).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(store.pending.filter((e) => e.type === "note_added").map((e) => e.payload)).toEqual([{ text: "pole bent" }]),
  );
  await waitFor(() => expect(location.pathname).toBe("/"));
});

test("a found report shows on the item until someone resolves it (FR-PUB-03)", async () => {
  const T0 = 1_756_684_800_000;
  await store.receive(
    [
      {
        id: "01000000000000000000000001",
        entity_type: "found_report",
        entity_id: "01000000000000000000000001",
        type: "created",
        actor_id: "public",
        device_id: "server",
        device_seq: 1,
        occurred_at: T0,
        clock_offset: 0,
        effective_at: T0,
        received_at: T0,
        seq: 1,
        payload: { code: "AAAAAAAAAA", item_id: tent, note: "by the gate", contact: "" },
      },
    ],
    1,
  );
  renderInShell(<ItemPage store={store} id={tent} />);
  const notice = screen.getByRole("note");
  expect(notice).toHaveTextContent("Reported found · by the gate");

  await user.click(within(notice).getByRole("button", { name: "Resolve" }));
  await waitFor(() => expect(screen.queryByRole("note")).not.toBeInTheDocument());
  expect(store.pending.at(-1)).toMatchObject({
    entity_type: "found_report",
    type: "field_changed",
    payload: { field: "resolved", value: true },
  });
});

test("what was paid, when and where shows as one line (FR-INV-12)", async () => {
  await act.updateItem(store, tent, { purchase_date: "2024-03-01", price: "249.99", supplier: "MEC" });
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.getByText("2024-03-01 · $249.99 · MEC")).toBeInTheDocument();
});

test("the record's changes are listed with old and new values (FR-USR-09)", async () => {
  await act.updateItem(store, tent, { name: "Tent 1 (green)" });
  renderInShell(<ItemPage store={store} id={tent} />);
  const rows = [...(section("Changes") as HTMLElement).querySelectorAll("li")].map((li) => li.textContent);
  expect(rows).toEqual([
    "Name: Tent 1 → Tent 1 (green) · Alice · 2025-08-31 17:00",
    "Created · Alice · 2025-08-31 17:00",
  ]);
});

test("an Admin merges a duplicate into the item it doubles, and lands on the survivor (FR-INV-13)", async () => {
  const other = await act.createItem(store, { name: "Tent 1 (again)" });
  renderInShell(<ItemPage store={store} id={other} />);
  await user.click(screen.getByRole("button", { name: "This is a duplicate record…" }));
  expect(screen.getByText(/second record of/)).toBeInTheDocument();
  await user.type(screen.getByLabelText("Search"), "tent 1");
  await user.click(screen.getByRole("button", { name: /^Tent 1$/ }));
  expect(screen.getByText("Merge Tent 1 (again) into Tent 1?")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Merge" }));

  await waitFor(() => expect(location.pathname).toBe(`/items/${tent}`));
  expect(item(store.state, other)?.merged_into).toBe(tent);
  expect(store.pending.at(-1)).toMatchObject({ type: "field_changed", payload: { field: "merged_into", value: tent } });
});

test("a merged item's page points at the survivor and offers nothing else", async () => {
  const other = await act.createItem(store, { name: "Tent 1 (again)" });
  await act.mergeItem(store, other, tent);
  renderInShell(<ItemPage store={store} id={other} />);
  expect(screen.getByRole("note")).toHaveTextContent("Merged into Tent 1");
  expect(screen.queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Tent 1" }));
  expect(location.pathname).toBe(`/items/${tent}`);
});

test("the survivor names what was merged into it, and a user sees no merge button", async () => {
  const other = await act.createItem(store, { name: "Tent 1 (again)" });
  await act.mergeItem(store, other, tent);
  await store.setMeta({ user: carol });
  renderInShell(<ItemPage store={store} id={tent} />);
  const line = screen.getByText("Merged from").nextElementSibling as HTMLElement;
  expect(line).toHaveTextContent("Tent 1 (again)");
  // The record it came from is a tap away; only an Admin may put it back (FR-INV-13).
  expect(within(line).queryByRole("button", { name: "Unmerge" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /duplicate record/ })).not.toBeInTheDocument();

  await user.click(within(line).getByRole("button", { name: "Tent 1 (again)" }));
  expect(location.pathname).toBe(`/items/${other}`);
});

test("an Admin undoes a merge from the survivor's own page (FR-INV-13)", async () => {
  const other = await act.createItem(store, { name: "Tent 1 (again)" });
  const third = await act.createItem(store, { name: "Tent 1 (third)" });
  await act.mergeItem(store, other, tent);
  await act.mergeItem(store, third, tent);
  renderInShell(<ItemPage store={store} id={tent} />);
  // One line each, each with its own way back.
  const lines = [...document.querySelectorAll(".merged-line")] as HTMLElement[];
  expect(lines.map((l) => l.textContent)).toEqual(["Tent 1 (again)Unmerge", "Tent 1 (third)Unmerge"]);

  await user.click(within(lines[0]!).getByRole("button", { name: "Unmerge" }));
  await waitFor(() => expect(item(store.state, other)?.merged_into).toBeNull());
  expect(item(store.state, third)?.merged_into).toBe(tent);
  expect(document.querySelectorAll(".merged-line")).toHaveLength(1);
});

test("two of the same gear are grouped under one name, and both stay (FR-INV-30)", async () => {
  const other = await act.createItem(store, { name: "Tent 2" });
  await act.bindCode(store, "ABCDEFGH23", tent);
  await store.setMeta({ user: carol });
  renderInShell(<ItemPage store={store} id={tent} />);

  // Grouping is an edit, so a user may do it; merging is still an Admin's (FR-INV-13, FR-INV-30).
  expect(screen.queryByRole("button", { name: /duplicate record/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Group with another item…" }));
  await user.click(screen.getByRole("button", { name: /^Tent 2/ }));
  expect(screen.getByText("Tent 2 becomes a name for both, and each becomes one of them.")).toBeInTheDocument();
  expect(screen.getByLabelText("The other one’s number")).toHaveValue("1");
  expect(screen.getByLabelText("This one’s number")).toHaveValue("2");
  await user.click(screen.getByRole("button", { name: "Group" }));

  // One field at a time, and the name it no longer needs goes last. Wait for that.
  await waitFor(() => expect(item(store.state, tent)?.name).toBeNull());
  const generic = generics(store.state)[0]!;
  expect(generic.name).toBe("Tent 2");
  expect(nameOf(store.state, other)).toBe("Tent 2 #1");
  expect(nameOf(store.state, tent)).toBe("Tent 2 #2");
  // Neither is hidden, and the sticker stays where it was.
  expect(item(store.state, tent)?.merged_into).toBeUndefined();
  expect(unitsOf(store.state, generic.id)).toHaveLength(2);
  expect(currentCode(store.state, tent)?.id).toBe("ABCDEFGH23");
});

test("grouping with a generic joins the one already there (FR-INV-30)", async () => {
  const tents = await act.createGeneric(store, { name: "4-person tent" });
  await act.addUnit(store, tents);
  renderInShell(<ItemPage store={store} id={tent} />);

  await user.click(screen.getByRole("button", { name: "Group with another item…" }));
  await user.click(screen.getByRole("button", { name: "4-person tent 1 unit" }));
  expect(screen.getByText("Tent 1 becomes one of 4-person tent.")).toBeInTheDocument();
  // No second number to confirm: the generic is already named.
  expect(screen.queryByLabelText("The other one’s number")).not.toBeInTheDocument();
  expect(screen.getByLabelText("This one’s number")).toHaveValue("2");
  await user.click(screen.getByRole("button", { name: "Group" }));

  await waitFor(() => expect(item(store.state, tent)?.name).toBeNull());
  expect(nameOf(store.state, tent)).toBe("4-person tent #2");
  expect(generics(store.state)).toHaveLength(1);
});

test("a group of two needs two different numbers (FR-INV-23, FR-INV-30)", async () => {
  await act.createItem(store, { name: "Tent 2" });
  renderInShell(<ItemPage store={store} id={tent} />);
  await user.click(screen.getByRole("button", { name: "Group with another item…" }));
  await user.click(screen.getByRole("button", { name: /^Tent 2/ }));
  await user.clear(screen.getByLabelText("This one’s number"));
  await user.type(screen.getByLabelText("This one’s number"), "1");
  await user.click(screen.getByRole("button", { name: "Group" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("the two need different numbers");
  // Nothing was written, so neither item moved.
  expect(generics(store.state)).toEqual([]);
  expect(item(store.state, tent)?.parent_id).toBeUndefined();
});

test("an Admin deletes a record made in error, in two taps (FR-INV-32)", async () => {
  renderInShell(<ItemPage store={store} id={tent} />);
  await user.click(screen.getByRole("button", { name: "Delete for good…" }));
  expect(item(store.state, tent)?.deleted).toBeUndefined();

  await user.click(screen.getByRole("button", { name: "Really delete? This cannot be undone" }));
  await waitFor(() => expect(location.pathname).toBe("/"));
  expect(item(store.state, tent)?.deleted).toBe(true);
  expect(store.pending.at(-1)).toMatchObject({ type: "field_changed", payload: { field: "deleted", value: true } });
});

test("a deleted item's page says so and offers nothing (FR-INV-32)", async () => {
  await act.deleteItem(store, tent);
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Tent 1");
  expect(screen.getByText("Deleted", { selector: ".badge" })).toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("This item was deleted.");
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete for good…" })).not.toBeInTheDocument();
});

test("only an Admin may delete, and only an item that is in (FR-INV-32)", async () => {
  await mv.checkOut(store, tent, {});
  const { unmount } = renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.queryByRole("button", { name: "Delete for good…" })).not.toBeInTheDocument();
  unmount();

  await mv.checkIn(store, tent, {});
  await store.setMeta({ user: carol });
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.queryByRole("button", { name: "Delete for good…" })).not.toBeInTheDocument();
});
