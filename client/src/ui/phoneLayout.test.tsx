import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as mv from "../lib/movement";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore } from "./codeTestKit";
import { ItemPage } from "./ItemPage";
import { alice, carol, renderInShell, seedUsers } from "./moveTestKit";
import { Repairs } from "./Repairs";

// Layout at phone width (NFR-USE-03). The test DOM cannot measure, so these check the
// rules and structure that keep things in place; e2e at a real width shows the look.
const styles = readFileSync(join(import.meta.dirname, "../styles.css"), "utf8");
let store: Store;
let sheet: HTMLStyleElement;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice, carol]);
  sheet = document.createElement("style");
  sheet.textContent = styles;
  document.head.append(sheet);
});

afterEach(() => {
  sheet.remove();
  unsaved.cancel();
});

test("a move button never shares a row with the shorter note buttons", async () => {
  const tent = await act.createItem(store, { name: "Tent 1" });
  await mv.checkOut(store, tent);
  await store.setMeta({ user: carol });
  navigate(`/items/${tent}`);
  renderInShell(<ItemPage store={store} id={tent} />);

  const moves = screen.getByRole("button", { name: "Transfer to me" }).parentElement!;
  const actions = moves.closest<HTMLElement>(".move-actions")!;
  const minors = within(actions).getByRole("button", { name: "Add note" }).parentElement!;
  expect(moves).not.toBe(minors);
  expect(moves.querySelectorAll("button.minor")).toHaveLength(0);
  expect([...minors.querySelectorAll("button")].every((b) => b.classList.contains("minor"))).toBe(true);
  // Alone in its row, the move takes the full width rather than half.
  expect(getComputedStyle(screen.getByRole("button", { name: "Transfer to me" })).gridColumn).toBe("1 / -1");
});

test("a unit's generic link sits inside the line, not as a full-width button", async () => {
  const tents = await act.createGeneric(store, { name: "Tent, 4-person" });
  const unit = await act.addUnit(store, tents);
  navigate(`/items/${unit}`);
  renderInShell(<ItemPage store={store} id={unit} />);

  const link = screen.getByRole("button", { name: "Tent, 4-person" });
  expect(link.closest("dd")).toHaveTextContent("Tent, 4-person · #1");
  expect(getComputedStyle(link).width).toBe("auto");
});

test("the repair history's date range may shrink to half a phone each", async () => {
  renderInShell(<Repairs store={store} />);

  const to = screen.getByLabelText("To", { selector: "input" });
  const label = to.closest("label")!;
  expect(label.parentElement).toHaveClass("row");
  expect(getComputedStyle(label).minWidth).toMatch(/^0(px)?$/);
  expect(getComputedStyle(to).minWidth).toMatch(/^0(px)?$/);
});
