import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import type { ServerEvent } from "../lib/api";
import { item } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore } from "./codeTestKit";
import { Conflicts } from "./Conflicts";
import { Inventory } from "./Inventory";
import { ItemPage } from "./ItemPage";
import { alice, carol, renderInShell, seedUsers } from "./moveTestKit";

// Two phones checked out one tent offline; the Quartermaster settles it (FR-OFF-10).
let store: Store;
let tent: string;

const T0 = 1_756_684_800_000; // 2025-09-01 00:00 UTC, 2025-08-31 17:00 in Vancouver
const bob = { id: "bob", name: "Bob", role: "user", active: true };

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice, carol, bob]);
  tent = await act.createItem(store, { name: "Tent 1" });
  // Before the store's clock, so a check-in recorded now comes after both in replay.
  await store.receive(
    [
      checkout("01000000000000000000000001", "phone-a", "bob", T0 - 7_200_000, "Spring camp"),
      checkout("01000000000000000000000002", "phone-b", "carol", T0 - 3_600_000),
    ],
    2,
  );
  navigate("/conflicts");
});

afterEach(() => unsaved.cancel());

function checkout(id: string, device: string, holder: string, at: number, event?: string): ServerEvent {
  return {
    id,
    entity_type: "item",
    entity_id: tent,
    type: "checked_out",
    actor_id: holder,
    device_id: device,
    device_seq: 1,
    occurred_at: at,
    clock_offset: 0,
    effective_at: at,
    received_at: at,
    seq: 1,
    payload: { holder_id: holder, event: event ?? null },
  };
}

const user = userEvent.setup();

test("both versions are shown in words, with who, what for, when, and which phone", () => {
  renderInShell(<Conflicts store={store} />);
  const card = screen.getByRole("region", { name: "Tent 1" });
  const versions = [...card.querySelectorAll("ol li")].map((li) => li.textContent);
  expect(versions).toEqual([
    "checked out by Bob · Spring camp · 2025-08-31 15:00 · device …ne-a",
    "checked out by Carol · 2025-08-31 16:00 · device …ne-b",
  ]);
  expect(within(card).getByRole("button", { name: "Keep: Carol has it" })).toBeInTheDocument();
});

test("It is back records a check-in, with the note, and the conflict is gone", async () => {
  renderInShell(<Conflicts store={store} />);
  await user.click(screen.getByRole("button", { name: "Add note" }));
  await user.type(screen.getByLabelText("Note"), "found in the hall");
  await user.click(screen.getByRole("button", { name: "It is back" }));
  await waitFor(() => expect(screen.getByText("No conflicts.")).toBeInTheDocument());
  expect(item(store.state, tent)?.status).toBe("in");
  expect(store.pending.slice(-2).map((e) => [e.type, e.payload.text])).toEqual([
    ["checked_in", undefined],
    ["note_added", "found in the hall"],
  ]);
});

test("Keep records the review and leaves the holder as they are", async () => {
  renderInShell(<Conflicts store={store} />);
  await user.click(screen.getByRole("button", { name: "Keep: Carol has it" }));
  await waitFor(() => expect(screen.getByText("No conflicts.")).toBeInTheDocument());
  expect(item(store.state, tent)).toMatchObject({ status: "out", holder_id: "carol" });
  expect(store.pending.at(-1)).toMatchObject({
    type: "field_changed",
    payload: { field: "reviewed_movement", value: "01000000000000000000000002", old: null },
  });
});

test("the home screen counts open conflicts and the item page points at the screen", async () => {
  navigate("/");
  renderInShell(<Inventory store={store} />);
  await user.click(screen.getByRole("button", { name: "Conflicts · 1" }));
  expect(location.pathname).toBe("/conflicts");

  navigate(`/items/${tent}`);
  renderInShell(<ItemPage store={store} id={tent} />);
  const notice = screen.getByRole("note");
  expect(notice).toHaveTextContent("Two check-outs overlapped.");
  await user.click(within(notice).getByRole("button", { name: "Review" }));
  expect(location.pathname).toBe("/conflicts");
});
