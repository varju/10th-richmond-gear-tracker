import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { item } from "../lib/inventory";
import * as mv from "../lib/movement";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { MoveActions } from "./MoveActions";
import { alice, renderInShell, seedUsers } from "./moveTestKit";

// The move buttons, and the note or fault that can ride on a move (FR-OUT-13, FR-REP-01).
let store: Store;
let tent: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
  tent = await act.createItem(store, { name: "Tent 1" });
});

const user = userEvent.setup();

test("a move that succeeds still calls onMoved when its fault is raised fine", async () => {
  const onMoved = vi.fn();
  renderInShell(<MoveActions store={store} it={item(store.state, tent)!} onMoved={onMoved} />);

  await user.click(screen.getByRole("button", { name: "Report a problem" }));
  await user.type(screen.getByLabelText("Problem"), "zipper broken");
  await user.click(screen.getByRole("button", { name: "Check out" }));

  await waitFor(() => expect(onMoved).toHaveBeenCalledWith("Checked out"));
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
