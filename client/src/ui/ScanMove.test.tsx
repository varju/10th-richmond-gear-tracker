import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { item } from "../lib/inventory";
import * as rep from "../lib/repairs";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore, printCodes } from "./codeTestKit";
import { LeaveDialog } from "./LeaveDialog";
import { alice, carol, renderInShell, seedUsers } from "./moveTestKit";
import * as mv from "../lib/movement";
import { todayIso } from "../lib/reservations";
import { SESSION_MS } from "../lib/session";
import { RESCAN_MS, Scan } from "./Scan";

// The movement session: a code on an item shows a card; one tap moves it.
const bob = { id: "bob", name: "Bob", role: "user", active: true };
let store: Store;
let tent: string;
/** How far the store's clock, which scanning sessions run on, has been moved on. */
let ahead = 0;

beforeEach(async () => {
  ahead = 0;
  store = await openStore(() => ahead);
  await seedUsers(store, [alice, carol]);
  await printCodes(store, ["AAAAAAAAAA", "BBBBBBBBBB", "CCCCCCCCCC"]);
  const cold = await act.createLocation(store, "Cold locker");
  tent = await act.createItem(store, {
    name: "Tent 1",
    home_location_id: cold,
    sub_location: "shelf 4",
  });
  await act.bindCode(store, "AAAAAAAAAA", tent);
  navigate("/scan");
});

afterEach(() => {
  unsaved.cancel();
  vi.restoreAllMocks();
  // @ts-expect-error test-only cleanup of a browser API stubbed per test
  delete navigator.vibrate;
});

const user = userEvent.setup();

async function typeCode(text: string) {
  const open = screen.queryByRole("button", { name: "Type a code instead" });
  if (open) await user.click(open);
  await user.type(screen.getByLabelText("Code or URL"), text);
  await user.click(screen.getByRole("button", { name: "Go" }));
}

const card = () => screen.getByRole("region", { name: "Tent 1" });
const pending = (type: string) => store.pending.filter((e) => e.type === type);

/** The first check-out of a session asks for the event (FR-OUT-05); these tests skip it. */
async function noEvent() {
  await user.click(
    within(await screen.findByRole("region", { name: "Which event" })).getByRole("button", { name: "No event" }),
  );
}

test("scanning a missing item clears the mark before the card shows (FR-INV-19)", async () => {
  await act.markMissing(store, tent);
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  // The mark clears before the card shows, so the card is what to wait for.
  await waitFor(() => expect(within(card()).getByRole("heading")).toHaveTextContent("Tent 1"));
  expect(item(store.state, tent)?.missing).toBe(false);
  expect(card()).toHaveTextContent("In");
  expect(store.pending.at(-1)).toMatchObject({
    type: "field_changed",
    payload: { field: "missing", value: false, old: true },
  });
});

test("an assigned code shows the card; Check out asks the event, offering the last one, and syncs", async () => {
  // Last used on an earlier evening: the session has ended, so the bar shows none (FR-OUT-38).
  await store.setMeta({ session_event: "Spring camp", session_event_at: store.now() - SESSION_MS });
  renderInShell(<Scan store={store} />);
  expect(screen.getByText("No event")).toBeInTheDocument();

  await typeCode("AAAAAAAAAA");
  expect(location.pathname).toBe("/scan");
  expect(within(card()).getByRole("heading")).toHaveTextContent("Tent 1");
  expect(card()).toHaveTextContent("Cold locker / shelf 4");
  expect(card()).toHaveTextContent("In");
  expect(within(card()).getByRole("button", { name: "Check out" })).toHaveClass("primary");
  expect(within(card()).queryByRole("button", { name: "Return" })).not.toBeInTheDocument();

  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  const ask = screen.getByRole("region", { name: "Which event" });
  await user.click(within(ask).getByRole("button", { name: /Spring camp/ }));
  expect(await screen.findByText("Checked out · Tent 1")).toHaveAttribute("role", "status");
  expect(screen.queryByRole("region", { name: "Tent 1" })).not.toBeInTheDocument();
  expect(pending("checked_out").map((e) => e.payload)).toEqual([
    { holder_id: "alice", event: "Spring camp", reservation_id: null },
  ]);
  expect(item(store.state, tent)).toMatchObject({
    status: "out",
    holder_id: "alice",
  });
});

test("a moved item is silent for three seconds, then the same code offers Return as the default", async () => {
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  await noEvent();
  await waitFor(() => expect(screen.queryByRole("region")).not.toBeInTheDocument());
  const afterCheckOut = store.pending.length;

  // The camera is still on the sticker; a repeat decode of the item just moved is ignored, and says so
  // in amber rather than the green of a read.
  const buzz = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: buzz, configurable: true });
  await typeCode("AAAAAAAAAA");
  await waitFor(() => expect(store.pending.length).toBe(afterCheckOut));
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  expect(document.querySelector(".viewfinder")).toHaveClass("ignored");
  expect(document.querySelector(".viewfinder")).not.toHaveClass("read");
  expect(buzz).not.toHaveBeenCalled();

  // Three seconds on, the same code is a scan again: the wrong tent went out, and the way to undo
  // that is to scan it and tap Return, which is the default for gear the scanner holds (FR-OUT-06).
  const later = Date.now() + RESCAN_MS;
  vi.spyOn(Date, "now").mockReturnValue(later);
  await typeCode("AAAAAAAAAA");
  expect(card()).toHaveTextContent("You have this");
  expect(within(card()).getByText("Put it back: Cold locker / shelf 4")).toHaveClass("move-home");
  expect(within(card()).queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();
  // Alice holds it, so there is no one to take it over from.
  expect(within(card()).queryByRole("button", { name: "Take over" })).not.toBeInTheDocument();

  // A return never asks for the event.
  await user.click(within(card()).getByRole("button", { name: "Return" }));
  expect(screen.queryByRole("region", { name: "Which event" })).not.toBeInTheDocument();
  expect(await screen.findByText("Returned · Tent 1")).toHaveAttribute("role", "status");
  expect(pending("checked_in")).toHaveLength(1);
  expect(item(store.state, tent)).toMatchObject({
    status: "in",
    holder_id: null,
  });
});

test("someone else's gear offers Return and Take over with no default; Take over names the check-out it replaces (FR-OUT-06, FR-OUT-12)", async () => {
  await store.setMeta({ session_event: "Spring camp" });
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(screen.getByRole("button", { name: "Check out" }));
  await user.click(screen.getByRole("button", { name: /Spring camp/ }));
  await screen.findByText("Checked out · Tent 1");
  const first = pending("checked_out")[0]!;

  await store.setMeta({ user: carol, session_event: "Cub camp" });
  // Carol opens the scan screen fresh; the moved log from Alice's visit does not carry over.
  cleanup();
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  expect(card()).toHaveTextContent(/Out with Alice · .+ ago · Spring camp/);
  // Return is on offer, so the home is as big as for one's own gear (FR-OUT-10).
  expect(within(card()).getByText("Put it back: Cold locker / shelf 4")).toHaveClass("move-home");
  const ret = within(card()).getByRole("button", { name: "Return" });
  const take = within(card()).getByRole("button", { name: "Take over" });
  expect(ret).not.toHaveClass("primary");
  expect(take).not.toHaveClass("primary");
  // Same phone, same session: the event was answered already, so Take over does not ask again.
  await user.click(take);
  expect(screen.queryByRole("region", { name: "Which event" })).not.toBeInTheDocument();
  expect(await screen.findByText("Transferred · Tent 1")).toHaveAttribute("role", "status");
  expect(pending("checked_out")[1]!.payload).toEqual({
    holder_id: "carol",
    event: "Cub camp",
    supersedes: first.id,
    reservation_id: null,
  });
  expect(item(store.state, tent)).toMatchObject({
    status: "out",
    holder_id: "carol",
  });
});

test("a note typed on the card rides on the movement (FR-OUT-13)", async () => {
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Add note" }));
  await user.type(screen.getByLabelText("Note"), "handed to a patrol leader");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  await noEvent();
  await screen.findByRole("status");

  const out = pending("checked_out")[0]!;
  expect(pending("note_added").map((e) => e.payload)).toEqual([
    { text: "handed to a patrol leader", movement_id: out.id },
  ]);
});

test("an open ticket shows on the card and does not block the move (FR-REP-05)", async () => {
  await rep.raiseTicket(store, tent, "zipper broken");
  await rep.raiseTicket(store, tent, "pole bent");
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  expect(within(card()).getByRole("note")).toHaveTextContent("Needs repair · pole bent · 1 more");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  await noEvent();
  expect(await screen.findByText("Checked out · Tent 1")).toBeInTheDocument();
});

test("a problem typed at check-in raises a ticket after the move, without leaving the flow (FR-OUT-09)", async () => {
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(screen.getByRole("button", { name: "Check out" }));
  await noEvent();
  await waitFor(() => expect(screen.queryByRole("region")).not.toBeInTheDocument());

  // Leaving and reopening the scan screen makes a moved item scannable again at once.
  cleanup();
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Report a problem" }));
  // One thing typed at a time: the note button goes while the problem is open.
  expect(within(card()).queryByRole("button", { name: "Add note" })).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("Problem"), "zipper broken on the bag");
  await user.click(within(card()).getByRole("button", { name: "Return" }));
  expect(await screen.findByText("Returned · Tent 1")).toHaveAttribute("role", "status");
  expect(location.pathname).toBe("/scan");

  const [ticket] = pending("created").filter((e) => e.entity_type === "repair");
  expect(ticket!.payload).toEqual({ item_id: tent, description: "zipper broken on the bag" });
  expect(ticket!.device_seq).toBeGreaterThan(pending("checked_in")[0]!.device_seq);
  expect(rep.openRepairs(store.state, tent)).toHaveLength(1);
});

test("a retired item cannot be moved from the card", async () => {
  await act.retireItem(store, tent);
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  expect(card()).toHaveTextContent("Retired. Cannot be checked out.");
  expect(within(card()).queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();
  expect(within(card()).getByRole("button", { name: "Open item" })).toBeInTheDocument();
  expect(within(card()).getByRole("button", { name: "Edit" })).toBeInTheDocument();
});

test("Skip dismisses the card; Edit opens the item's form", async () => {
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Skip" }));
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  expect(store.pending.filter((e) => e.type.startsWith("checked"))).toHaveLength(0);

  await typeCode("AAAAAAAAAA");
  // Skip does not silence the item: the same code opens the card again.
  expect(within(card()).getByRole("heading")).toHaveTextContent("Tent 1");
  await user.click(within(card()).getByRole("button", { name: "Edit" }));
  expect(location.pathname + location.search).toBe(`/items/${tent}?edit=1`);
});

test("the session event is set once and persists on the device (FR-OUT-05)", async () => {
  renderInShell(<Scan store={store} />);
  expect(screen.getByText("No event")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.type(screen.getByLabelText("Event"), "Spring camp");
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByText("Event: Spring camp")).toBeInTheDocument();
  expect(store.meta.session_event).toBe("Spring camp");
  // Nothing moved yet, so nothing to ask about (FR-OUT-40).
  expect(screen.queryByRole("group", { name: "Earlier moves" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(await screen.findByText("No event")).toBeInTheDocument();
  expect(store.meta.session_event).toBeUndefined();

  // Set by hand this session, so Check out does not ask again.
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  expect(await screen.findByText("Checked out · Tent 1")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Which event" })).not.toBeInTheDocument();
});

/** Check out Tent 1 and Stove under the first answer, Cub camp. */
async function twoUnderCubCamp() {
  const stove = await act.createItem(store, { name: "Stove" });
  await act.bindCode(store, "CCCCCCCCCC", stove);
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  const ask = screen.getByRole("region", { name: "Which event" });
  await user.type(within(ask).getByLabelText("Event"), "Cub camp");
  await user.click(within(ask).getByRole("button", { name: "Create" }));
  await screen.findByText("Checked out · Tent 1");
  await typeCode("CCCCCCCCCC");
  await user.click(within(screen.getByRole("region", { name: "Stove" })).getByRole("button", { name: "Check out" }));
  await screen.findByText("Checked out · Stove");
  return stove;
}

async function changeTo(name: string) {
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.clear(screen.getByLabelText("Event"));
  await user.type(screen.getByLabelText("Event"), name);
  await user.click(screen.getByRole("button", { name: "Create" }));
}

const earlier = () => screen.findByRole("group", { name: "Earlier moves" });

test("changing the event offers to correct the session's earlier moves; yes appends one correction each (FR-OUT-40)", async () => {
  const stove = await twoUnderCubCamp();
  await changeTo("Scout camp");
  expect(await earlier()).toHaveTextContent("Also change the 2 items already moved?");
  await user.click(within(await earlier()).getByRole("button", { name: "Change them" }));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Earlier moves" })).not.toBeInTheDocument());
  expect(screen.getByText("Event: Scout camp")).toBeInTheDocument();
  expect(pending("event_corrected").map((e) => [e.entity_id, e.payload.event, e.payload.reservation_id])).toEqual([
    [tent, "Scout camp", null],
    [stove, "Scout camp", null],
  ]);
  expect(item(store.state, tent)?.movement?.event).toBe("Scout camp");

  // Those moves are now under the new event; clearing it asks about them again.
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(await earlier()).toHaveTextContent("Also change the 2 items already moved?");
});

test("the question outlives leaving the screen, and a double tap corrects each move once (FR-OUT-40)", async () => {
  await twoUnderCubCamp();
  await changeTo("Scout camp");
  await earlier();
  cleanup();
  renderInShell(<Scan store={store} />);
  await user.dblClick(within(await earlier()).getByRole("button", { name: "Change them" }));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Earlier moves" })).not.toBeInTheDocument());
  expect(pending("event_corrected")).toHaveLength(2);
});

test("the question counts items, not moves (FR-OUT-40)", async () => {
  await twoUnderCubCamp();
  await mv.checkIn(store, tent);
  await mv.checkOut(store, tent, { event: "Cub camp" });
  await changeTo("Scout camp");
  expect(await earlier()).toHaveTextContent("Also change the 2 items already moved?");
  await user.click(within(await earlier()).getByRole("button", { name: "Change them" }));
  await waitFor(() => expect(pending("event_corrected")).toHaveLength(3));
});

test("a tap that races the session's end changes nothing and says so (FR-OUT-40)", async () => {
  await twoUnderCubCamp();
  await changeTo("Scout camp");
  const ask = await earlier();
  ahead += SESSION_MS;
  await user.click(within(ask).getByRole("button", { name: "Change them" }));
  expect(await screen.findByText("The session has ended. Nothing was changed.")).toHaveAttribute("role", "alert");
  expect(pending("event_corrected")).toHaveLength(0);
  expect(screen.queryByRole("group", { name: "Earlier moves" })).not.toBeInTheDocument();
});

test("Only new ones leaves the earlier moves as they were (FR-OUT-40)", async () => {
  await twoUnderCubCamp();
  await changeTo("Scout camp");
  await user.click(within(await earlier()).getByRole("button", { name: "Only new ones" }));
  expect(screen.getByText("Event: Scout camp")).toBeInTheDocument();
  expect(pending("event_corrected")).toHaveLength(0);
  expect(item(store.state, tent)?.movement?.event).toBe("Cub camp");
});

test("the event is asked once a visit, offers today's calendar events, and Cancel moves nothing (FR-OUT-05, FR-RES-20)", async () => {
  const today = todayIso(Date.now());
  await store.setMeta({
    calendar_events: [
      { uid: "a", summary: "Cub camp", starts: today, ends: today, all_day: true },
      { uid: "b", summary: "Later camp", starts: "2999-01-01", ends: "2999-01-02", all_day: true },
    ],
  });
  const stove = await act.createItem(store, { name: "Stove" });
  await act.bindCode(store, "CCCCCCCCCC", stove);
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  const ask = screen.getByRole("region", { name: "Which event" });
  expect(within(ask).queryByRole("button", { name: /Later camp/ })).not.toBeInTheDocument();
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(pending("checked_out")).toHaveLength(0);

  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  await user.click(
    within(screen.getByRole("region", { name: "Which event" })).getByRole("button", { name: /Cub camp/ }),
  );
  await screen.findByText("Checked out · Tent 1");
  expect(screen.getByText("Event: Cub camp")).toBeInTheDocument();

  // The second check-out of the visit takes the same event without asking.
  await typeCode("CCCCCCCCCC");
  await user.click(within(screen.getByRole("region", { name: "Stove" })).getByRole("button", { name: "Check out" }));
  await screen.findByText("Checked out · Stove");
  expect(pending("checked_out").map((e) => e.payload.event)).toEqual(["Cub camp", "Cub camp"]);
});

test("No event is one tap and records none", async () => {
  await store.setMeta({ session_event: "Spring camp" });
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  await noEvent();
  await screen.findByText("Checked out · Tent 1");
  expect(pending("checked_out")[0]!.payload.event).toBeNull();
  expect(store.meta.session_event).toBeUndefined();
});

test("Transfer to… hands gear to another member; the history names both (FR-OUT-26)", async () => {
  await seedUsers(store, [alice, carol, bob]);
  await mv.checkOut(store, tent);
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Transfer to…" }));
  const picker = screen.getByRole("region", { name: "Transfer to" });
  // Alice holds it, so she is not offered.
  expect(within(picker).queryByRole("button", { name: "Alice" })).not.toBeInTheDocument();
  await user.type(within(picker).getByLabelText("Transfer to"), "bo");
  expect(within(picker).queryByRole("button", { name: "Carol" })).not.toBeInTheDocument();
  await user.click(within(picker).getByRole("button", { name: "Bob" }));
  await noEvent();
  expect(await screen.findByText("Transferred to Bob · Tent 1")).toHaveAttribute("role", "status");
  const handed = pending("checked_out").at(-1)!;
  expect(handed.actor_id).toBe("alice");
  expect(handed.payload).toMatchObject({ holder_id: "bob", supersedes: pending("checked_out")[0]!.id });
  expect(item(store.state, tent)).toMatchObject({ status: "out", holder_id: "bob" });
});

test("a note or a problem can be saved without moving the item (FR-OUT-27)", async () => {
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Add note" }));
  await user.type(screen.getByLabelText("Note"), "dented pole");
  await user.click(within(card()).getByRole("button", { name: "Save without moving" }));
  expect(await screen.findByText("Note saved · Tent 1")).toHaveAttribute("role", "status");
  expect(screen.queryByRole("region", { name: "Tent 1" })).not.toBeInTheDocument();
  expect(pending("note_added").map((e) => e.payload)).toEqual([{ text: "dented pole" }]);
  expect(store.pending.filter((e) => e.type.startsWith("checked"))).toHaveLength(0);
  expect(item(store.state, tent)?.status).toBe("in");
});

test("an unassigned code still lands on /g/<code>; an unknown one is refused", async () => {
  renderInShell(<Scan store={store} />);
  await typeCode("ZZZZZZZZZZ");
  expect(screen.getByRole("status")).toHaveTextContent("Not one of our codes");
  expect(location.pathname).toBe("/scan");
  await typeCode("BBBBBBBBBB");
  expect(location.pathname).toBe("/g/BBBBBBBBBB");
});

test("Skip with a typed note asks first; Keep editing keeps the card, Discard drops it", async () => {
  renderInShell(
    <>
      <Scan store={store} />
      <LeaveDialog />
    </>,
  );
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Add note" }));
  await user.type(screen.getByLabelText("Note"), "muddy");
  await user.click(within(card()).getByRole("button", { name: "Skip" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(card()).toBeInTheDocument();
  expect(screen.getByLabelText("Note")).toHaveValue("muddy");

  await user.click(within(card()).getByRole("button", { name: "Skip" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
  expect(screen.queryByRole("region", { name: "Tent 1" })).not.toBeInTheDocument();
});

test("the answer holds across leaving the scan screen, and a session ends four hours on (FR-OUT-38)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await act.bindCode(store, "CCCCCCCCCC", stove);
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  await noEvent();
  await screen.findByText("Checked out · Tent 1");

  // Open item and back, or a trip through /g/: the screen remounts, and the session goes on.
  cleanup();
  renderInShell(<Scan store={store} />);
  await typeCode("CCCCCCCCCC");
  await user.click(within(screen.getByRole("region", { name: "Stove" })).getByRole("button", { name: "Check out" }));
  expect(await screen.findByText("Checked out · Stove")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Which event" })).not.toBeInTheDocument();

  // Four hours later it is a new session, and the next check-out asks again.
  await mv.checkIn(store, tent);
  ahead += SESSION_MS;
  cleanup();
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  expect(screen.getByRole("region", { name: "Which event" })).toBeInTheDocument();
});

test("plain scanning never packs a reservation, even one an older build left in the session", async () => {
  await store.setMeta({
    session_event: "Fall Camp",
    session_reservation_id: "r-fall",
    session_event_at: store.now() - SESSION_MS,
  });
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  await user.click(
    within(screen.getByRole("region", { name: "Which event" })).getByRole("button", { name: /Fall Camp/ }),
  );
  await screen.findByText("Checked out · Tent 1");
  expect(pending("checked_out")[0]!.payload).toMatchObject({ event: "Fall Camp", reservation_id: null });
  expect(store.meta.session_reservation_id).toBeUndefined();
});

test("each move keeps the session going: it ends four hours after the last one, not the first (FR-OUT-38)", async () => {
  await store.setMeta({ session_event: "Spring camp", session_event_at: store.now() - SESSION_MS + 60_000 });
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  await screen.findByText("Checked out · Tent 1");
  expect(store.meta.session_event_at).toBe(item(store.state, tent)!.movement!.at);

  // Two hours on, the session set nearly four hours before the move is still running; a return,
  // made outside the scan screen in the same session, keeps it going too.
  ahead += 2 * 3_600_000;
  await mv.checkIn(store, tent);
  ahead += 3 * 3_600_000;
  cleanup();
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  await screen.findByText("Checked out · Tent 1");
  expect(pending("checked_out").map((e) => e.payload.event)).toEqual(["Spring camp", "Spring camp"]);
});

test("an event shown when the card opened but ended before the tap asks again, never recording nothing", async () => {
  await store.setMeta({ session_event: "Spring camp", session_event_at: store.now() });
  renderInShell(<Scan store={store} />);
  expect(screen.getByText("Event: Spring camp")).toBeInTheDocument();
  await typeCode("AAAAAAAAAA");
  ahead += SESSION_MS;
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  const ask = screen.getByRole("region", { name: "Which event" });
  await user.click(within(ask).getByRole("button", { name: /Spring camp/ }));
  await screen.findByText("Checked out · Tent 1");
  expect(pending("checked_out")[0]!.payload.event).toBe("Spring camp");
});
