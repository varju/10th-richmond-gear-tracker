import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { item } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { openStore, printCodes } from "./codeTestKit";
import { alice, carol, renderInShell, seedUsers } from "./moveTestKit";
import { Scan } from "./Scan";

// The movement session: a code on an item shows a card; one tap moves it.
let store: Store;
let tent: string;

beforeEach(async () => {
  store = await openStore();
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

const user = userEvent.setup();

async function typeCode(text: string) {
  const open = screen.queryByRole("button", { name: "Type a code instead" });
  if (open) await user.click(open);
  await user.type(screen.getByLabelText("Code or URL"), text);
  await user.click(screen.getByRole("button", { name: "Go" }));
}

const card = () => screen.getByRole("region", { name: "Tent 1" });
const pending = (type: string) => store.pending.filter((e) => e.type === type);

test("an assigned code shows the card; one tap checks out under the session event and syncs", async () => {
  await store.setMeta({ session_event: "Spring camp" });
  const { sync } = renderInShell(<Scan store={store} />);
  expect(screen.getByText("Event: Spring camp")).toBeInTheDocument();

  await typeCode("AAAAAAAAAA");
  expect(location.pathname).toBe("/scan");
  expect(within(card()).getByRole("heading")).toHaveTextContent("Tent 1");
  expect(card()).toHaveTextContent("Cold locker / shelf 4");
  expect(card()).toHaveTextContent("In");
  expect(within(card()).queryByRole("button", { name: "Check in" })).not.toBeInTheDocument();

  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  expect(await screen.findByText("Checked out · Tent 1")).toHaveAttribute("role", "status");
  expect(screen.queryByRole("region", { name: "Tent 1" })).not.toBeInTheDocument();
  expect(sync).toHaveBeenCalledTimes(1);
  expect(pending("checked_out").map((e) => e.payload)).toEqual([{ holder_id: "alice", event: "Spring camp" }]);
  expect(item(store.state, tent)).toMatchObject({
    status: "out",
    holder_id: "alice",
  });
});

test("the same code again shows who has it, with the home to put it back in, and checks it in", async () => {
  const { sync } = renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(screen.getByRole("button", { name: "Check out" }));
  await waitFor(() => expect(screen.queryByRole("region")).not.toBeInTheDocument());

  await typeCode("AAAAAAAAAA");
  expect(card()).toHaveTextContent("Out · Alice");
  expect(card()).toHaveTextContent("Put it back: Cold locker / shelf 4");
  expect(within(card()).queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();
  // Alice holds it, so there is no one to transfer from.
  expect(within(card()).queryByRole("button", { name: "Transfer to me" })).not.toBeInTheDocument();

  await user.click(within(card()).getByRole("button", { name: "Check in" }));
  expect(await screen.findByText("Checked in · Tent 1")).toHaveAttribute("role", "status");
  expect(sync).toHaveBeenCalledTimes(2);
  expect(pending("checked_in")).toHaveLength(1);
  expect(item(store.state, tent)).toMatchObject({
    status: "in",
    holder_id: null,
  });
});

test("someone else's gear offers a transfer, which names the check-out it replaces (FR-OUT-12)", async () => {
  await store.setMeta({ session_event: "Spring camp" });
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await user.click(screen.getByRole("button", { name: "Check out" }));
  await screen.findByText("Checked out · Tent 1");
  const first = pending("checked_out")[0]!;

  await store.setMeta({ user: carol, session_event: "Cub camp" });
  await typeCode("AAAAAAAAAA");
  expect(card()).toHaveTextContent("Out · Alice");
  await user.click(within(card()).getByRole("button", { name: "Transfer to me" }));
  expect(await screen.findByText("Transferred · Tent 1")).toHaveAttribute("role", "status");
  expect(pending("checked_out")[1]!.payload).toEqual({
    holder_id: "carol",
    event: "Cub camp",
    supersedes: first.id,
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
  await screen.findByRole("status");

  const out = pending("checked_out")[0]!;
  expect(pending("note_added").map((e) => e.payload)).toEqual([
    { text: "handed to a patrol leader", movement_id: out.id },
  ]);
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
  await user.click(within(card()).getByRole("button", { name: "Edit" }));
  expect(location.pathname + location.search).toBe(`/items/${tent}?edit=1`);
});

test("the session event is set once and persists on the device (FR-OUT-05)", async () => {
  renderInShell(<Scan store={store} />);
  expect(screen.getByText("No event")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.type(screen.getByLabelText("Event"), "Spring camp");
  await user.click(screen.getByRole("button", { name: "Set" }));
  expect(await screen.findByText("Event: Spring camp")).toBeInTheDocument();
  expect(store.meta.session_event).toBe("Spring camp");

  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(await screen.findByText("No event")).toBeInTheDocument();
  expect(store.meta.session_event).toBeUndefined();
});

test("an unassigned code still lands on /g/<code>; an unknown one is refused", async () => {
  renderInShell(<Scan store={store} />);
  await typeCode("ZZZZZZZZZZ");
  expect(screen.getByRole("status")).toHaveTextContent("Not one of our codes");
  expect(location.pathname).toBe("/scan");
  await typeCode("BBBBBBBBBB");
  expect(location.pathname).toBe("/g/BBBBBBBBBB");
});
