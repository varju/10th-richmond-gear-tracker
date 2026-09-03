import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as inv from "../lib/inventory";
import * as mv from "../lib/movement";
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
  tents = await act.createGeneric(store, { name: "4-person tent", home_location_id: cold });
  t1 = await act.addUnit(store, tents);
  t2 = await act.addUnit(store, tents);
  fall = await res.createReservation(store, {
    event: "Fall Camp",
    starts: "2026-10-02",
    ends: "2026-10-04",
    items: [t1],
    generics: [{ item_id: tents, quantity: 1 }],
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
    generics: [],
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
  await user.type(screen.getByLabelText("Add an item"), "tent #1");
  await user.click(screen.getByRole("button", { name: /4-person tent #1/ }));
  expect(screen.getByLabelText("Remove 4-person tent #1")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Already reserved for Fall Camp (4-person tent #1).");
  expect(res.reservations(store.state)).toHaveLength(1);

  // Swap the tent for one that is free, and it saves.
  await user.click(screen.getByLabelText("Remove 4-person tent #1"));
  await user.type(screen.getByLabelText("Add an item"), "tent #2");
  await user.click(screen.getByRole("button", { name: /4-person tent #2/ }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(res.reservations(store.state).find((r) => r.event === "Cub camp")).toBeDefined());
  const made = res.reservations(store.state).find((r) => r.event === "Cub camp")!;
  expect(made).toMatchObject({ starts: "2026-10-04", ends: "2026-10-05", items: [t2], generics: [] });
  expect(location.pathname).toBe(`/reservations/${made.id}`);
});

test("a generic is reserved by count, and too many of it names the other camp (FR-RES-13, FR-RES-15)", async () => {
  navigate("/reservations/new");
  renderInShell(<ReservationForm store={store} />);
  await user.type(screen.getByLabelText("Event"), "Cub camp");
  await fillDates("2026-10-03", "2026-10-03");
  await user.selectOptions(screen.getByLabelText("Item"), tents);
  await user.clear(screen.getByLabelText("How many"));
  await user.type(screen.getByLabelText("How many"), "2");
  await user.click(screen.getByRole("button", { name: "Add" }));
  expect(screen.getByText("2 × 4-person tent")).toBeInTheDocument();

  // Fall Camp has one tent by name and one by count; we own two.
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Fall Camp (4 × 4-person tent, we have 2)");
});

test("duplicate carries the gear and the name over, not the dates (FR-RES-10)", async () => {
  navigate(`/reservations/new?from=${fall}`);
  renderInShell(<ReservationForm store={store} from={fall} />);
  expect(screen.getByLabelText("Event")).toHaveValue("Fall Camp");
  expect(screen.getByLabelText("Starts")).toHaveValue("");
  expect(screen.getByLabelText("Remove 4-person tent #1")).toBeInTheDocument();
  expect(screen.getByText("1 × 4-person tent")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("the page shows the gear, starts the packing session under its event, and can cancel (FR-RES-03)", async () => {
  navigate(`/reservations/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />);
  expect(screen.getByRole("heading", { name: "Fall Camp" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /4-person tent #1/ })).toHaveTextContent("Cold locker · In");
  expect(screen.getByText("1 × 4-person tent")).toBeInTheDocument();
  expect(screen.queryByRole("note")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Check out" }));
  expect(store.meta.session_event).toBe("Fall Camp");
  expect(location.pathname + location.search).toBe(`/scan?mode=out&reservation=${fall}`);

  await user.click(screen.getByRole("button", { name: "Cancel reservation" }));
  await user.click(screen.getByRole("button", { name: "Really cancel?" }));
  expect(await screen.findByText("Cancelled")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check out" })).not.toBeInTheDocument();
  expect(res.reservations(store.state)).toEqual([]);
});

test("two camps saved on two devices are named against each other on the page (FR-RES-05)", async () => {
  // Nothing checked this one, as if it came in a sync from another device.
  await res.createReservation(store, {
    event: "Cub camp",
    starts: "2026-10-04",
    ends: "2026-10-05",
    items: [t1],
    generics: [],
  });
  renderInShell(<ReservationPage store={store} id={fall} />);
  expect(screen.getByRole("note")).toHaveTextContent("Also reserved for Cub camp (4-person tent #1).");
});

test("Edit opens the form with the reservation in it and saves changed fields only", async () => {
  navigate(`/reservations/${fall}/edit`);
  renderInShell(<ReservationForm store={store} id={fall} />);
  expect(screen.getByLabelText("Event")).toHaveValue("Fall Camp");
  expect(screen.getByLabelText("Ends")).toHaveValue("2026-10-04");
  await user.click(screen.getByLabelText("Remove 4-person tent #1"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  // The gear list goes out one line at a time, never as a whole list (FR-RES-07).
  await waitFor(() =>
    expect(
      store.pending.filter((e) => e.entity_id === fall && e.type !== "created").map((e) => [e.type, e.payload]),
    ).toEqual([["item_removed", { item_id: t1 }]]),
  );
  expect(location.pathname).toBe(`/reservations/${fall}`);
});

test("gear that is out under nothing is claimed from the page in one tap (FR-RES-17, S-RES-07)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  const out = await mv.checkOut(store, t1); // Thursday, no event set
  await mv.checkOut(store, stove, { event: "Somebody else's trip" });
  navigate(`/reservations/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => T0);

  await user.click(screen.getByLabelText("It's with us: 4-person tent #1"));
  await waitFor(() => expect(inv.item(store.state, t1)?.movement).toMatchObject({ event: "Fall Camp" }));
  expect(store.pending.at(-1)).toMatchObject({
    type: "event_corrected",
    entity_id: t1,
    payload: { movement_id: out.id, event: "Fall Camp" },
  });
  // It is out for us now, so the row no longer offers the tap.
  expect(screen.queryByLabelText("It's with us: 4-person tent #1")).not.toBeInTheDocument();

  // Anything else that is out is offered below the list, and joins the gear list when picked.
  await user.selectOptions(screen.getByLabelText("Gear that is out"), stove);
  await user.click(screen.getByRole("button", { name: "It's with us" }));
  await waitFor(() => expect(res.reservation(store.state, fall)?.items).toEqual([t1, stove]));
  expect(inv.item(store.state, stove)?.movement).toMatchObject({ event: "Fall Camp" });
  expect(store.pending.filter((e) => e.type === "checked_out" || e.type === "checked_in")).toHaveLength(2);
});
