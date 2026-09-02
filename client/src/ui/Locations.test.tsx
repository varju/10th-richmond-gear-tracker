import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as mv from "../lib/movement";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { LocationPage, Locations } from "./Locations";
import { alice, seedUsers } from "./moveTestKit";

// Browse by location, then shelf: "what belongs on shelf 4?" (FR-INV-10).
let store: Store;
let cold: string;
let warm: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
  cold = await act.createLocation(store, "Cold locker");
  warm = await act.createLocation(store, "Warm locker");
  await act.createItem(store, { name: "Tent 1", home_location_id: cold, sub_location: "shelf 4" });
  const t2 = await act.createItem(store, { name: "Tent 2", home_location_id: cold, sub_location: "shelf 4" });
  await act.createItem(store, { name: "Bag", home_location_id: cold, sub_location: "" });
  await mv.checkOut(store, t2);
  navigate("/locations");
});

const user = userEvent.setup();

test("locations list their item count and open shelf by shelf", async () => {
  render(<Locations store={store} />);
  expect(screen.getByRole("button", { name: /Cold locker/ })).toHaveTextContent("3 items");
  expect(screen.getByRole("button", { name: /Warm locker/ })).toHaveTextContent("0 items");
  await user.click(screen.getByRole("button", { name: /Cold locker/ }));
  expect(location.pathname).toBe(`/locations/${cold}`);
});

test("a location shows its shelves, items with no shelf last, with status", async () => {
  render(<LocationPage store={store} id={cold} />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Cold locker");
  const sections = screen.getAllByRole("region");
  expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["shelf 4", "No shelf"]);
  const shelf = within(sections[0]!);
  expect(shelf.getAllByRole("button").map((b) => b.textContent)).toEqual(["Tent 1In", "Tent 2Out · Alice"]);
  await user.click(shelf.getByRole("button", { name: /Tent 1/ }));
  expect(location.pathname).toMatch(/^\/items\//);
});

test("an empty location says so", () => {
  render(<LocationPage store={store} id={warm} />);
  expect(screen.getByText("Nothing lives here.")).toBeInTheDocument();
});
