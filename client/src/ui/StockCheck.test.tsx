import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { item } from "../lib/inventory";
import * as mv from "../lib/movement";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { openStore, printCodes } from "./codeTestKit";
import { type FakeCamera, fakeCamera, stopFakeCamera } from "./scanTestKit";
import { renderInShell } from "./moveTestKit";
import { StockCheck } from "./StockCheck";

// Walk one shelf, scan what is there, and see what is misplaced and what is not (FR-RPT-09).
let store: Store;
let cold: string;
let tent1: string;
let stove: string;

let camera: FakeCamera;

beforeEach(async () => {
  camera = fakeCamera();
  store = await openStore();
  await printCodes(store, ["AAAAAAAAAA", "BBBBBBBBBB", "CCCCCCCCCC"]);
  cold = await act.createLocation(store, "Cold locker");
  const warm = await act.createLocation(store, "Warm locker");
  tent1 = await act.createItem(store, { name: "Tent 1", home_location_id: cold, sub_location: "shelf 4" });
  const tent2 = await act.createItem(store, { name: "Tent 2", home_location_id: cold, sub_location: "shelf 4" });
  stove = await act.createItem(store, { name: "Stove", home_location_id: warm, sub_location: "" });
  await act.bindCode(store, "AAAAAAAAAA", tent1);
  await act.bindCode(store, "BBBBBBBBBB", stove);
  await mv.checkOut(store, tent2);
  navigate("/stock-check");
});

afterEach(() => {
  stopFakeCamera();
  // @ts-expect-error test-only cleanup of a browser API stubbed per test
  delete navigator.vibrate;
});

const user = userEvent.setup();

const region = (name: string) => screen.getByRole("region", { name });
const rows = (name: string) =>
  within(region(name))
    .queryAllByRole("button")
    .filter((b) => b.classList.contains("item"))
    .map((b) => b.textContent);

test("pick where you are, scan, and the lists follow; the walk survives a closed app", async () => {
  renderInShell(<StockCheck store={store} native />);
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText("Location"), cold);
  await user.selectOptions(screen.getByLabelText("Shelf"), "shelf 4");
  await user.click(screen.getByRole("button", { name: "Start" }));

  // Out gear is not expected on the shelf; only Tent 1 is.
  expect(await screen.findByText("Cold locker / shelf 4 · 0 in place")).toBeInTheDocument();
  expect(rows("Not seen yet")).toEqual(["Tent 1Cold locker / shelf 4"]);
  expect(region("Misplaced here")).toHaveTextContent("Nothing out of place.");

  await camera.scan("BBBBBBBBBB");
  expect(await screen.findByText("Misplaced · Stove · home Warm locker")).toHaveAttribute("role", "status");
  expect(rows("Misplaced here")).toEqual(["StoveHome: Warm locker"]);

  await camera.scan("AAAAAAAAAA");
  expect(await screen.findByText("Seen · Tent 1")).toBeInTheDocument();
  await waitFor(() => expect(region("Not seen yet")).toHaveTextContent("Everything that belongs here has been seen."));
  expect(screen.getByText("Cold locker / shelf 4 · 1 in place")).toBeInTheDocument();
  expect(store.meta.stock_check).toMatchObject({ location_id: cold, sub_location: "shelf 4", seen: [stove, tent1] });

  await camera.scan("CCCCCCCCCC");
  expect(await screen.findByText("Not on anything yet")).toBeInTheDocument();

  // Finish shows the summary; Done clears the walk.
  await user.click(screen.getByRole("button", { name: "Finish" }));
  expect(screen.getByRole("heading", { name: "Misplaced here · 1" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Not seen yet · 0" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(store.meta.stock_check).toBeUndefined());
  expect(location.pathname).toBe("/");
});

test("a scan during the walk clears missing (FR-INV-19)", async () => {
  await act.markMissing(store, tent1);
  await store.setMeta({ stock_check: { location_id: cold, seen: [], started_at: 1 } });
  renderInShell(<StockCheck store={store} native />);
  expect(screen.getByText("Cold locker · 0 in place")).toBeInTheDocument();
  await camera.scan("AAAAAAAAAA");
  await waitFor(() => expect(item(store.state, tent1)?.missing).toBe(false));
});

test("a code we know buzzes the phone; one we do not leaves it alone", async () => {
  const buzz = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: buzz, configurable: true });
  renderInShell(<StockCheck store={store} native />);
  await user.selectOptions(screen.getByLabelText("Location"), cold);
  await user.click(screen.getByRole("button", { name: "Start" }));
  await camera.scan("hello");
  expect(buzz).not.toHaveBeenCalled();
  await camera.scan("AAAAAAAAAA");
  expect(buzz).toHaveBeenCalledWith(30);
});

test("Seen beside a row counts as a sighting, for gear with no code or an awkward sticker", async () => {
  renderInShell(<StockCheck store={store} native />);
  await user.selectOptions(screen.getByLabelText("Location"), cold);
  await user.selectOptions(screen.getByLabelText("Shelf"), "shelf 4");
  await user.click(screen.getByRole("button", { name: "Start" }));
  expect(rows("Not seen yet")).toEqual(["Tent 1Cold locker / shelf 4"]);

  await user.click(screen.getByRole("button", { name: "Seen: Tent 1" }));
  expect(await screen.findByText("Seen · Tent 1")).toBeInTheDocument();
  await waitFor(() => expect(region("Not seen yet")).toHaveTextContent("Everything that belongs here has been seen."));
  expect(store.meta.stock_check).toMatchObject({ seen: [tent1] });
});

test("New shelf starts a check on the typed shelf, and Start waits for a name", async () => {
  renderInShell(<StockCheck store={store} native />);
  await user.selectOptions(screen.getByLabelText("Location"), cold);
  await user.selectOptions(screen.getByLabelText("Shelf"), "New shelf…");
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  await user.type(screen.getByLabelText("New shelf"), "  ");
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  await user.type(screen.getByLabelText("New shelf"), " shelf 9 ");
  await user.click(screen.getByRole("button", { name: "Start" }));
  expect(await screen.findByText("Cold locker / shelf 9 · 0 in place")).toBeInTheDocument();
  expect(store.meta.stock_check).toMatchObject({ location_id: cold, sub_location: "shelf 9" });
});

test("Belongs here makes the checked shelf the item's home, and the row leaves Misplaced", async () => {
  renderInShell(<StockCheck store={store} native />);
  await user.selectOptions(screen.getByLabelText("Location"), cold);
  await user.selectOptions(screen.getByLabelText("Shelf"), "shelf 4");
  await user.click(screen.getByRole("button", { name: "Start" }));
  await camera.scan("BBBBBBBBBB");
  await waitFor(() => expect(rows("Misplaced here")).toEqual(["StoveHome: Warm locker"]));

  await user.click(screen.getByRole("button", { name: "Belongs here: Stove" }));
  await waitFor(() => expect(region("Misplaced here")).toHaveTextContent("Nothing out of place."));
  expect(item(store.state, stove)).toMatchObject({ home_location_id: cold, sub_location: "shelf 4" });
});

test("Belongs here on Whole location clears the shelf", async () => {
  await act.updateItem(store, stove, { sub_location: "top" });
  await store.setMeta({ stock_check: { location_id: cold, seen: [stove], started_at: 1 } });
  renderInShell(<StockCheck store={store} native />);
  expect(rows("Misplaced here")).toEqual(["StoveHome: Warm locker / top"]);

  await user.click(screen.getByRole("button", { name: "Belongs here: Stove" }));
  await waitFor(() => expect(region("Misplaced here")).toHaveTextContent("Nothing out of place."));
  expect(item(store.state, stove)).toMatchObject({ home_location_id: cold, sub_location: null });
});

test("All belong here asks, then moves every misplaced item", async () => {
  const lamp = await act.createItem(store, { name: "Lamp", home_location_id: cold, sub_location: "shelf 2" });
  await store.setMeta({
    stock_check: { location_id: cold, sub_location: "shelf 4", seen: [stove, lamp], started_at: 1 },
  });
  renderInShell(<StockCheck store={store} native />);
  expect(rows("Misplaced here")).toHaveLength(2);

  await user.click(screen.getByRole("button", { name: "All belong here" }));
  expect(rows("Misplaced here")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Really move 2 homes here?" }));
  await waitFor(() => expect(region("Misplaced here")).toHaveTextContent("Nothing out of place."));
  for (const id of [stove, lamp]) {
    expect(item(store.state, id)).toMatchObject({ home_location_id: cold, sub_location: "shelf 4" });
  }
});

test("while All belong here runs, the row buttons are disabled", async () => {
  const lamp = await act.createItem(store, { name: "Lamp", home_location_id: cold, sub_location: "shelf 2" });
  await store.setMeta({
    stock_check: { location_id: cold, sub_location: "shelf 4", seen: [stove, lamp], started_at: 1 },
  });
  renderInShell(<StockCheck store={store} native />);
  await user.click(screen.getByRole("button", { name: "All belong here" }));
  fireEvent.click(screen.getByRole("button", { name: "Really move 2 homes here?" }));
  expect(screen.getByRole("button", { name: "Belongs here: Stove" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Belongs here: Lamp" })).toBeDisabled();
  await waitFor(() => expect(region("Misplaced here")).toHaveTextContent("Nothing out of place."));
  const moves = store.pending.filter((e) => e.type === "field_changed" && e.payload.field === "sub_location");
  expect(moves).toHaveLength(2);
});

test("a typed shelf that matches an existing one, ignoring case and spaces, uses the existing label", async () => {
  renderInShell(<StockCheck store={store} native />);
  await user.selectOptions(screen.getByLabelText("Location"), cold);
  await user.selectOptions(screen.getByLabelText("Shelf"), "New shelf…");
  expect(screen.getByLabelText("New shelf")).toHaveFocus();
  await user.type(screen.getByLabelText("New shelf"), "  SHELF   4 ");
  await user.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("Cold locker / shelf 4 · 0 in place");
  expect(store.meta.stock_check).toMatchObject({ sub_location: "shelf 4" });
});

test("a double tap on Belongs here records one change", async () => {
  await store.setMeta({ stock_check: { location_id: cold, seen: [stove], started_at: 1 } });
  renderInShell(<StockCheck store={store} native />);
  await user.dblClick(screen.getByRole("button", { name: "Belongs here: Stove" }));
  await waitFor(() => expect(region("Misplaced here")).toHaveTextContent("Nothing out of place."));
  const moves = store.pending.filter(
    (e) => e.entity_id === stove && e.type === "field_changed" && e.payload.field === "home_location_id",
  );
  expect(moves).toHaveLength(1);
});

test("a retired item has no Belongs here and is left out of All belong here", async () => {
  const lamp = await act.createItem(store, { name: "Lamp", home_location_id: cold, sub_location: "shelf 2" });
  const pot = await act.createItem(store, { name: "Pot", home_location_id: cold, sub_location: "shelf 2" });
  await act.retireItem(store, pot);
  await store.setMeta({
    stock_check: { location_id: cold, sub_location: "shelf 4", seen: [stove, lamp, pot], started_at: 1 },
  });
  renderInShell(<StockCheck store={store} native />);
  expect(screen.queryByRole("button", { name: "Belongs here: Pot" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "All belong here" }));
  await user.click(screen.getByRole("button", { name: "Really move 2 homes here?" }));
  await waitFor(() => expect(item(store.state, lamp)?.sub_location).toBe("shelf 4"));
  expect(item(store.state, pot)?.sub_location).toBe("shelf 2");
});

test("All belong here leaves out gear a person keeps; its own button still works", async () => {
  const lamp = await act.createItem(store, { name: "Lamp", home_location_id: cold, sub_location: "shelf 2" });
  const mine = await act.createItem(store, { name: "Axe", home_user_id: "someone" });
  await store.setMeta({
    stock_check: { location_id: cold, sub_location: "shelf 4", seen: [stove, lamp, mine], started_at: 1 },
  });
  renderInShell(<StockCheck store={store} native />);
  await user.click(screen.getByRole("button", { name: "All belong here" }));
  await user.click(screen.getByRole("button", { name: "Really move 2 homes here?" }));
  await waitFor(() => expect(rows("Misplaced here")).toHaveLength(1));
  expect(screen.queryByRole("button", { name: "All belong here" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Belongs here: Axe" }));
  await waitFor(() => expect(item(store.state, mine)).toMatchObject({ home_user_id: null, sub_location: "shelf 4" }));
});

test("a failure says how many moved, and a later success clears it", async () => {
  const lamp = await act.createItem(store, { name: "Lamp", home_location_id: cold, sub_location: "shelf 2" });
  const pot = await act.createItem(store, { name: "Pot", home_location_id: cold, sub_location: "shelf 2" });
  await store.setMeta({
    stock_check: { location_id: cold, sub_location: "shelf 4", seen: [stove, lamp, pot], started_at: 1 },
  });
  const signedIn = store.meta.user;
  await store.setMeta({ user: undefined });
  renderInShell(<StockCheck store={store} native />);
  await user.click(screen.getByRole("button", { name: "All belong here" }));
  await user.click(screen.getByRole("button", { name: "Really move 3 homes here?" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("not signed in");
  expect(item(store.state, lamp)?.sub_location).toBe("shelf 2");

  await store.setMeta({ user: signedIn });
  await user.click(screen.getByRole("button", { name: "Belongs here: Stove" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});
