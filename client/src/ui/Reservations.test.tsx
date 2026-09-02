import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as res from "../lib/reservations";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore } from "./codeTestKit";
import { alice, renderInShell, seedUsers } from "./moveTestKit";
import { ReservationForm } from "./ReservationForm";
import { ReservationPage } from "./ReservationPage";
import { Reservations } from "./Reservations";

// Planning a camp (S-RES-01) and naming the clash with another one (S-RES-05).
const T0 = 1_756_684_800_000; // 2025-09-01
let store: Store;
let tents: string;
let t1: string;
let t2: string;
let fall: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
  const cold = await act.createLocation(store, "Cold locker");
  tents = await act.createType(store, "4-person tent");
  t1 = await act.createItem(store, { name: "Tent 1", home_location_id: cold, type_id: tents });
  t2 = await act.createItem(store, { name: "Tent 2", home_location_id: cold, type_id: tents });
  fall = await res.createReservation(store, {
    event: "Fall Camp",
    starts: "2026-10-02",
    ends: "2026-10-04",
    items: [t1],
    types: [{ type_id: tents, quantity: 1 }],
  });
});

afterEach(() => unsaved.cancel());

const user = userEvent.setup();

async function fillDates(starts: string, ends: string) {
  await user.type(screen.getByLabelText("Starts"), starts);
  await user.type(screen.getByLabelText("Ends"), ends);
}

test("the list shows what is ahead, with past camps folded away", async () => {
  await res.createReservation(store, {
    event: "Spring camp",
    starts: "2025-04-10",
    ends: "2025-04-12",
    items: [],
    types: [],
  });
  navigate("/reservations");
  renderInShell(<Reservations store={store} />, () => T0);
  expect(screen.getByRole("button", { name: /Fall Camp/ })).toHaveTextContent("2026-10-02 – 2026-10-04 · 2 items");
  expect(screen.getByText("Past (1)")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /Fall Camp/ }));
  expect(location.pathname).toBe(`/reservations/${fall}`);
});

test("a new reservation is built from a name, dates and gear; an item already booked blocks it (FR-RES-01, FR-RES-05)", async () => {
  navigate("/reservations/new");
  renderInShell(<ReservationForm store={store} />);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await user.type(screen.getByLabelText("Event"), "Cub camp");
  await fillDates("2026-10-04", "2026-10-05");
  await user.type(screen.getByLabelText("Add an item"), "tent 1");
  await user.click(screen.getByRole("button", { name: /Tent 1/ }));
  expect(screen.getByLabelText("Remove Tent 1")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Already reserved for Fall Camp (Tent 1).");
  expect(res.reservations(store.state)).toHaveLength(1);

  // Swap the tent for one that is free, and it saves.
  await user.click(screen.getByLabelText("Remove Tent 1"));
  await user.type(screen.getByLabelText("Add an item"), "tent 2");
  await user.click(screen.getByRole("button", { name: /Tent 2/ }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(res.reservations(store.state).find((r) => r.event === "Cub camp")).toBeDefined());
  const made = res.reservations(store.state).find((r) => r.event === "Cub camp")!;
  expect(made).toMatchObject({ starts: "2026-10-04", ends: "2026-10-05", items: [t2], types: [] });
  expect(location.pathname).toBe(`/reservations/${made.id}`);
});

test("a type is reserved by count, and too many of it names the other camp (FR-RES-13, FR-RES-15)", async () => {
  navigate("/reservations/new");
  renderInShell(<ReservationForm store={store} />);
  await user.type(screen.getByLabelText("Event"), "Cub camp");
  await fillDates("2026-10-03", "2026-10-03");
  await user.selectOptions(screen.getByLabelText("Type"), tents);
  await user.clear(screen.getByLabelText("How many"));
  await user.type(screen.getByLabelText("How many"), "2");
  await user.click(screen.getByRole("button", { name: "Add" }));
  expect(screen.getByText("2 × 4-person tent")).toBeInTheDocument();

  // Fall Camp has one tent by name and one by type; we own two.
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Fall Camp (4 × 4-person tent, we have 2)");
});

test("duplicate carries the gear and the name over, not the dates (FR-RES-10)", async () => {
  navigate(`/reservations/new?from=${fall}`);
  renderInShell(<ReservationForm store={store} from={fall} />);
  expect(screen.getByLabelText("Event")).toHaveValue("Fall Camp");
  expect(screen.getByLabelText("Starts")).toHaveValue("");
  expect(screen.getByLabelText("Remove Tent 1")).toBeInTheDocument();
  expect(screen.getByText("1 × 4-person tent")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("the page shows the gear, starts the packing session under its event, and can cancel (FR-RES-03)", async () => {
  navigate(`/reservations/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />);
  expect(screen.getByRole("heading", { name: "Fall Camp" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Tent 1/ })).toHaveTextContent("Cold locker · In");
  expect(screen.getByText("1 × 4-person tent")).toBeInTheDocument();
  expect(screen.queryByRole("note")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Check out" }));
  expect(store.meta.session_event).toBe("Fall Camp");
  expect(location.pathname + location.search).toBe(`/scan?reservation=${fall}`);

  await user.click(screen.getByRole("button", { name: "Cancel reservation" }));
  await user.click(screen.getByRole("button", { name: "Really cancel?" }));
  expect(await screen.findByText("Cancelled")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();
  expect(res.reservations(store.state)).toEqual([]);
});

test("two camps saved on two phones are named against each other on the page (FR-RES-05)", async () => {
  // Nothing checked this one, as if it came in a sync from another phone.
  await res.createReservation(store, {
    event: "Cub camp",
    starts: "2026-10-04",
    ends: "2026-10-05",
    items: [t1],
    types: [],
  });
  renderInShell(<ReservationPage store={store} id={fall} />);
  expect(screen.getByRole("note")).toHaveTextContent("Also reserved for Cub camp (Tent 1).");
});

test("Edit opens the form with the reservation in it and saves changed fields only", async () => {
  navigate(`/reservations/${fall}/edit`);
  renderInShell(<ReservationForm store={store} id={fall} />);
  expect(screen.getByLabelText("Event")).toHaveValue("Fall Camp");
  expect(screen.getByLabelText("Ends")).toHaveValue("2026-10-04");
  await user.click(screen.getByLabelText("Remove Tent 1"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(store.pending.filter((e) => e.type === "field_changed").map((e) => e.payload)).toEqual([
      { field: "items", value: [], old: [t1] },
    ]),
  );
  expect(location.pathname).toBe(`/reservations/${fall}`);
});
