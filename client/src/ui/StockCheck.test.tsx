import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { item } from "../lib/inventory";
import * as mv from "../lib/movement";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { openStore, printCodes } from "./codeTestKit";
import { renderInShell } from "./moveTestKit";
import { StockCheck } from "./StockCheck";

// Walk one shelf, scan what is there, and see what is misplaced and what is not (FR-RPT-09).
let store: Store;
let cold: string;
let tent1: string;
let stove: string;

beforeEach(async () => {
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

const region = (name: string) => screen.getByRole("region", { name });
const rows = (name: string) =>
  within(region(name))
    .queryAllByRole("button")
    .filter((b) => b.classList.contains("item"))
    .map((b) => b.textContent);

test("pick where you are, scan, and the lists follow; the walk survives a closed app", async () => {
  renderInShell(<StockCheck store={store} />);
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText("Location"), cold);
  await user.selectOptions(screen.getByLabelText("Shelf"), "shelf 4");
  await user.click(screen.getByRole("button", { name: "Start" }));

  // Out gear is not expected on the shelf; only Tent 1 is.
  expect(await screen.findByText("Cold locker / shelf 4 · 0 in place")).toBeInTheDocument();
  expect(rows("Not seen yet")).toEqual(["Tent 1Cold locker / shelf 4"]);
  expect(region("Misplaced here")).toHaveTextContent("Nothing out of place.");

  await typeCode("BBBBBBBBBB");
  expect(await screen.findByText("Misplaced · Stove · home Warm locker")).toHaveAttribute("role", "status");
  expect(rows("Misplaced here")).toEqual(["StoveHome: Warm locker"]);

  await typeCode("AAAAAAAAAA");
  expect(await screen.findByText("Seen · Tent 1")).toBeInTheDocument();
  await waitFor(() => expect(region("Not seen yet")).toHaveTextContent("Everything that belongs here has been seen."));
  expect(screen.getByText("Cold locker / shelf 4 · 1 in place")).toBeInTheDocument();
  expect(store.meta.stock_check).toMatchObject({ location_id: cold, sub_location: "shelf 4", seen: [stove, tent1] });

  await typeCode("CCCCCCCCCC");
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
  renderInShell(<StockCheck store={store} />);
  expect(screen.getByText("Cold locker · 0 in place")).toBeInTheDocument();
  await typeCode("AAAAAAAAAA");
  await waitFor(() => expect(item(store.state, tent1)?.missing).toBe(false));
});

test("a code we know buzzes the phone; one we do not leaves it alone", async () => {
  const buzz = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: buzz, configurable: true });
  renderInShell(<StockCheck store={store} />);
  await user.selectOptions(screen.getByLabelText("Location"), cold);
  await user.click(screen.getByRole("button", { name: "Start" }));
  await typeCode("hello");
  expect(buzz).not.toHaveBeenCalled();
  await typeCode("AAAAAAAAAA");
  expect(buzz).toHaveBeenCalledWith(30);
});

test("Seen beside a row counts as a sighting, for gear with no code or an awkward sticker", async () => {
  renderInShell(<StockCheck store={store} />);
  await user.selectOptions(screen.getByLabelText("Location"), cold);
  await user.selectOptions(screen.getByLabelText("Shelf"), "shelf 4");
  await user.click(screen.getByRole("button", { name: "Start" }));
  expect(rows("Not seen yet")).toEqual(["Tent 1Cold locker / shelf 4"]);

  await user.click(screen.getByRole("button", { name: "Seen: Tent 1" }));
  expect(await screen.findByText("Seen · Tent 1")).toBeInTheDocument();
  await waitFor(() => expect(region("Not seen yet")).toHaveTextContent("Everything that belongs here has been seen."));
  expect(store.meta.stock_check).toMatchObject({ seen: [tent1] });
});
