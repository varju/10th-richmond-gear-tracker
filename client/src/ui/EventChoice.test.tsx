import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { openDb } from "../lib/db";
import { checkOut, correctEvent, waitingMoves } from "../lib/movement";
import { settleWaiting } from "../lib/session";
import { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { EventStrip } from "./EventChoice";
import { alice, eventStrip, renderInShell } from "./moveTestKit";

// The event question after a session's first check-out (FR-OUT-05): the move is done, whatever is tapped.
let store: Store;

async function waitingCheckOut(on: Store) {
  await on.setMeta({ user: alice });
  const tent = await act.createItem(on, { name: "Tent" });
  return checkOut(on, tent, { waits: true });
}

beforeEach(async () => {
  store = await openStore();
});

afterEach(() => vi.restoreAllMocks());

const user = userEvent.setup();
const ask = () => screen.getByRole("region", { name: "Which event" });

test("the strip shows only while check-outs wait, with Create and No event as equal answers and no Cancel", async () => {
  renderInShell(<EventStrip store={store} />);
  expect(screen.queryByRole("region", { name: "Which event" })).not.toBeInTheDocument();
  await waitingCheckOut(store);
  expect(
    within(await screen.findByRole("region", { name: "Which event" })).getByRole("button", { name: "No event" }),
  ).toHaveClass("primary");
  expect(within(ask()).getByRole("button", { name: "Create" })).toHaveClass("primary");
  expect(within(ask()).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
});

test("a double tap on No event answers once and clears the strip", async () => {
  await waitingCheckOut(store);
  renderInShell(<EventStrip store={store} />);
  await user.dblClick(within(await eventStrip()).getByRole("button", { name: "No event" }));
  await vi.waitFor(() => expect(store.meta.session_waiting).toBeUndefined());
  expect(screen.queryByRole("region", { name: "Which event" })).not.toBeInTheDocument();
  expect(waitingMoves(store)).toEqual([]);
});

test("an event that cannot be saved says so, keeps the move, and leaves the buttons working", async () => {
  // A real store whose database goes away after the move: every write fails, as it does when the browser drops it.
  const db = await openDb("closed", new IDBFactory());
  const broken = await Store.open(db, () => 1);
  const out = await waitingCheckOut(broken);
  db.close();
  // The raw error goes to the console for whoever debugs it, not onto the strip.
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  renderInShell(<EventStrip store={broken} />);
  await user.click(within(await eventStrip()).getByRole("button", { name: "No event" }));
  expect(await within(ask()).findByRole("alert")).toHaveTextContent("Could not save the event. Try again.");
  expect(logged).toHaveBeenCalled();
  expect(broken.pending.map((e) => e.id)).toContain(out.id);
  expect(within(ask()).getByRole("button", { name: "No event" })).toBeEnabled();
});

test("typing finds names used before, and one row per calendar event (FR-RES-26, FR-RES-27)", async () => {
  const today = new Date().toISOString().slice(0, 10);
  await store.setMeta({
    calendar_events: ["a", "b", "c"].map((uid) => ({
      uid,
      summary: "Apple Day",
      starts: today,
      ends: today,
      all_day: true,
    })),
  });
  await store.record({
    entity_type: "reservation",
    entity_id: "r1",
    type: "created",
    actor_id: "alice",
    payload: { event: "Apple pressing", starts: today, ends: today, items: [], generics: [] },
  });
  await waitingCheckOut(store);
  renderInShell(<EventStrip store={store} />);
  await user.type(within(ask()).getByLabelText("Event"), "apple");
  expect(
    within(ask())
      .getAllByRole("button", { name: /Apple/ })
      .map((b) => b.textContent),
  ).toEqual([`Apple Day${today}`, "Apple pressingUsed before"]);
});

test("the strip and its error stay until the answer is saved, even once every move is corrected", async () => {
  const db = await openDb("half", new IDBFactory());
  const broken = await Store.open(db, () => 1);
  const out = await waitingCheckOut(broken);
  await correctEvent(broken, out.entity_id, out.id, "Cub camp", null);
  await settleWaiting(broken, out.id);
  expect(broken.meta.session_waiting).toEqual([]);
  db.close();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  renderInShell(<EventStrip store={broken} />);
  await user.click(within(await eventStrip()).getByRole("button", { name: "No event" }));
  expect(await within(ask()).findByRole("alert")).toHaveTextContent("Could not save the event. Try again.");
  expect(ask()).toBeInTheDocument();
});
