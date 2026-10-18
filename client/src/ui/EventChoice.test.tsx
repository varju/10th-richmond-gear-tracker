import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDb } from "../lib/db";
import { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { useEventQuestion } from "./EventChoice";
import { renderInShell } from "./moveTestKit";

// The event question in front of a move (FR-OUT-05): whatever is tapped, the move runs once.
let store: Store;
let runs: number;

beforeEach(async () => {
  store = await openStore();
  runs = 0;
});

function Harness({ store }: { store: Store }) {
  const { askThen, question } = useEventQuestion(store);
  return (
    question(null) ?? (
      <button type="button" onClick={() => askThen(() => (runs += 1))}>
        Move
      </button>
    )
  );
}

afterEach(() => vi.restoreAllMocks());

const user = userEvent.setup();
const ask = () => screen.getByRole("region", { name: "Which event" });

test("a double tap on No event runs the move once", async () => {
  renderInShell(<Harness store={store} />);
  await user.click(screen.getByRole("button", { name: "Move" }));
  await user.dblClick(within(ask()).getByRole("button", { name: "No event" }));
  await screen.findByRole("button", { name: "Move" });
  expect(runs).toBe(1);
});

test("a double tap on the last event runs the move once, and the next move does not ask", async () => {
  await store.setMeta({ session_event: "Spring camp" });
  renderInShell(<Harness store={store} />);
  await user.click(screen.getByRole("button", { name: "Move" }));
  await user.dblClick(within(ask()).getByRole("button", { name: /Spring camp/ }));
  await screen.findByRole("button", { name: "Move" });
  expect(runs).toBe(1);
  await user.click(screen.getByRole("button", { name: "Move" }));
  expect(runs).toBe(2);
});

test("an event that cannot be saved says so, moves nothing, and leaves the buttons working", async () => {
  // A real store whose database has gone away: every write fails, as it does when the browser drops it.
  const db = await openDb("closed", new IDBFactory());
  const broken = await Store.open(db, () => 1);
  db.close();
  // The raw error goes to the console for whoever debugs it, not onto the card.
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  renderInShell(<Harness store={broken} />);
  await user.click(screen.getByRole("button", { name: "Move" }));
  await user.click(within(ask()).getByRole("button", { name: "No event" }));
  expect(await within(ask()).findByRole("alert")).toHaveTextContent("Could not save the event. Try again.");
  expect(logged).toHaveBeenCalled();
  expect(runs).toBe(0);
  expect(within(ask()).getByRole("button", { name: "No event" })).toBeEnabled();
  await user.click(within(ask()).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument();
  expect(runs).toBe(0);
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
  renderInShell(<Harness store={store} />);
  await user.click(screen.getByRole("button", { name: "Move" }));
  await user.type(within(ask()).getByLabelText("Event"), "apple");
  expect(
    within(ask())
      .getAllByRole("button", { name: /Apple/ })
      .map((b) => b.textContent),
  ).toEqual([`Apple Day${today}`, "Apple pressingUsed before"]);
});
