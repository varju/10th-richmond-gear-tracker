import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { item } from "../lib/inventory";
import * as mv from "../lib/movement";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { CONFIRM_MS, MoveActions, movedText } from "./MoveActions";
import { alice, renderInShell, seedUsers, inSession } from "./moveTestKit";

// The move buttons, and the note or fault that can ride on a move (FR-OUT-13, FR-REP-01).
let store: Store;
let tent: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
  tent = await act.createItem(store, { name: "Tent 1" });
  // A session is running, so a check-out does not stop to ask the event (FR-OUT-05).
  await inSession(store);
});

const user = userEvent.setup();

test("a move that succeeds still calls onMoved when its fault is raised fine", async () => {
  const onMoved = vi.fn();
  renderInShell(<MoveActions store={store} it={item(store.state, tent)!} onMoved={onMoved} />);

  await user.click(screen.getByRole("button", { name: "Report a problem" }));
  await user.type(screen.getByLabelText("Problem"), "zipper broken");
  await user.click(screen.getByRole("button", { name: "Check out" }));

  await waitFor(() => expect(onMoved).toHaveBeenCalledWith("Checked out", undefined, undefined));
  expect(item(store.state, tent)?.status).toBe("out");
  expect(store.pending.at(-1)).toMatchObject({ entity_type: "repair", payload: { description: "zipper broken" } });
  // There is no way to make raiseTicket fail here without mocking it (it only refuses a
  // missing item or blank text), so the "ticket fails after a successful move" branch
  // is exercised by inspection of MoveActions.tsx rather than by a test.
});

test("a move that fails is reported, the fault text is kept for a retry, and no ticket is raised", async () => {
  const onMoved = vi.fn();
  const stale = item(store.state, tent)!;
  renderInShell(<MoveActions store={store} it={stale} onMoved={onMoved} />);

  await user.click(screen.getByRole("button", { name: "Report a problem" }));
  await user.type(screen.getByLabelText("Problem"), "zipper broken");

  // Another device takes it first, so the stale "it" prop's Check out button now fails for real.
  await mv.checkOut(store, tent);
  await user.click(screen.getByRole("button", { name: "Check out" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("already out");
  expect(screen.getByLabelText("Problem")).toHaveValue("zipper broken");
  expect(onMoved).not.toHaveBeenCalled();
  expect(store.pending.some((e) => e.entity_type === "repair")).toBe(false);
});

test("Send home with needs a name, offers recent ones, and keeps the Scouter as holder (FR-OUT-46, FR-OUT-48)", async () => {
  const other = await act.createItem(store, { name: "Tent 2" });
  await mv.checkOut(store, other);
  await mv.sendItemHome(store, other, { cleaner: "Smith family" });
  await mv.checkIn(store, other);
  await mv.checkOut(store, tent, { event: "Camp" });
  const onMoved = vi.fn();
  renderInShell(<MoveActions store={store} it={item(store.state, tent)!} onMoved={onMoved} />);

  await user.click(screen.getByRole("button", { name: "Send home with…" }));
  const send = screen.getByRole("button", { name: "Send home" });
  expect(send).toBeDisabled();

  await user.type(screen.getByLabelText("Taken home by"), "smi");
  await user.click(screen.getByRole("button", { name: "Smith family" }));
  expect(screen.getByLabelText("Taken home by")).toHaveValue("Smith family");
  await user.click(send);

  await waitFor(() => expect(onMoved).toHaveBeenCalledWith("Sent home", undefined, "Smith family"));
  expect(item(store.state, tent)).toMatchObject({ status: "out", holder_id: "alice" });
  expect(item(store.state, tent)?.movement?.cleaner).toBe("Smith family");
});

test("Send home with is not offered for gear that is in", () => {
  renderInShell(<MoveActions store={store} it={item(store.state, tent)!} onMoved={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Send home with…" })).toBeNull();
});

test("Back from a name clears it and leaves the Scouter holding it (FR-OUT-51)", async () => {
  await mv.checkOut(store, tent);
  await mv.sendItemHome(store, tent, { cleaner: "Smith family" });
  const onMoved = vi.fn();
  renderInShell(<MoveActions store={store} it={item(store.state, tent)!} onMoved={onMoved} />);

  await user.click(screen.getByRole("button", { name: "Back from Smith family" }));

  await waitFor(() => expect(onMoved).toHaveBeenCalledWith("Back from home", undefined, "Smith family"));
  expect(movedText("Back from home", "Smith family")).toBe("Back from Smith family");
  expect(movedText("Sent home", "Smith family")).toBe("Sent home with Smith family");
  expect(movedText("Returned")).toBe("Returned");
  expect(item(store.state, tent)).toMatchObject({ status: "out", holder_id: "alice" });
  expect(item(store.state, tent)?.movement?.cleaner).toBeUndefined();
});

test("the move buttons pause after a move, so a second tap cannot undo it (FR-OUT-52)", async () => {
  await mv.checkOut(store, tent);
  await mv.sendItemHome(store, tent, { cleaner: "Smith family" });
  function Page() {
    const [, setTick] = useState(0);
    return <MoveActions store={store} it={item(store.state, tent)!} onMoved={() => setTick((n) => n + 1)} />;
  }
  renderInShell(<Page />);

  await user.click(screen.getByRole("button", { name: "Back from Smith family" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Return" })).toBeDisabled());
  await user.click(screen.getByRole("button", { name: "Return" }));
  expect(item(store.state, tent)).toMatchObject({ status: "out", holder_id: "alice" });

  await waitFor(() => expect(screen.getByRole("button", { name: "Return" })).toBeEnabled(), {
    timeout: CONFIRM_MS + 1000,
  });
  await user.click(screen.getByRole("button", { name: "Return" }));
  await waitFor(() => expect(item(store.state, tent)?.status).toBe("in"));
});

test("a move that fails does not pause the buttons", async () => {
  const stale = item(store.state, tent)!;
  renderInShell(<MoveActions store={store} it={stale} onMoved={vi.fn()} />);
  await mv.checkOut(store, tent);
  await user.click(screen.getByRole("button", { name: "Check out" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("already out");
  expect(screen.getByRole("button", { name: "Check out" })).toBeEnabled();
});

test("Return is disabled straight after a check-out", async () => {
  function Page() {
    const [, setTick] = useState(0);
    return <MoveActions store={store} it={item(store.state, tent)!} onMoved={() => setTick((n) => n + 1)} />;
  }
  renderInShell(<Page />);

  await user.click(screen.getByRole("button", { name: "Check out" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Return" })).toBeDisabled());
  await user.click(screen.getByRole("button", { name: "Return" }));
  expect(item(store.state, tent)?.status).toBe("out");
});
