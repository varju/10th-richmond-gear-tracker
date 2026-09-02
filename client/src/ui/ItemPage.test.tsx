import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { DAY_MS } from "../lib/clock";
import { item } from "../lib/inventory";
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

test("a fault reported from the page raises a ticket, which flags the item (FR-REP-01, FR-REP-05)", async () => {
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  // The actions area has its own "Report a fault", for a fault that rides on a move.
  const main = document.querySelector("main") as HTMLElement;
  await user.click(within(main).getByRole("button", { name: "Report a fault" }));
  await user.type(screen.getByLabelText("Fault"), "zipper broken");
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

test("?edit=1 opens the form straight away, and saving drops it from the URL", async () => {
  navigate(`/items/${tent}?edit=1`);
  renderInShell(<ItemPage store={store} id={tent} />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Edit item");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Item");
  expect(location.search).toBe("");
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
