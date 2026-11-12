import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import * as inv from "../lib/inventory";
import { checkOutUnplanned } from "../lib/unplannedTestKit";
import * as mv from "../lib/movement";
import * as res from "../lib/reservations";
import { IDBFactory } from "fake-indexeddb";
import { openDb } from "../lib/db";
import { navigate } from "../lib/router";
import { Store } from "../lib/store";
import { type Shell, ShellContext } from "../shell";
import { newUlid } from "../lib/ulid";
import { unsaved } from "../lib/unsaved";
import { openStore } from "./codeTestKit";
import { alice, renderInShell, seedUsers } from "./moveTestKit";
import { ReservationForm } from "./ReservationForm";
import { ReservationPage } from "./ReservationPage";
import { Reservations } from "./Reservations";
import { desk } from "./widthTestKit";

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

/** Filling Starts fills Ends too, so a different end date replaces it. */
async function fillDates(starts: string, ends: string) {
  await user.type(screen.getByLabelText("Starts"), starts);
  if (ends !== starts) {
    await user.clear(screen.getByLabelText("Ends"));
    await user.type(screen.getByLabelText("Ends"), ends);
  }
}

test("the Events page shows the event check-outs go to, and changes it", async () => {
  navigate("/events");
  renderInShell(<Reservations store={store} />, () => T0);
  expect(screen.getByText("Check-outs have no event")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.type(screen.getByLabelText("Event"), "Apple Day");
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByText("Check-outs go to: Apple Day")).toBeInTheDocument();
  expect(store.meta.session_event).toBe("Apple Day");
  await waitFor(() => expect(location.search).toBe(""));

  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(screen.getByRole("button", { name: "No event" }));
  expect(await screen.findByText("Check-outs have no event")).toBeInTheDocument();
});

test("Back from changing the check-out event returns to Events", async () => {
  navigate("/items");
  navigate("/events");
  renderInShell(<Reservations store={store} />, () => T0);
  await user.click(screen.getByRole("button", { name: "Change" }));
  expect(await screen.findByLabelText("Event")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByText("Check-outs have no event")).toBeInTheDocument();
  expect(location.pathname).toBe("/events");

  await user.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(location.pathname).toBe("/items"));
});

test("a cold load of the event picker goes back to Events", async () => {
  history.replaceState({ depth: 0 }, "", "/events?change=1");
  renderInShell(<Reservations store={store} />, () => T0);
  expect(await screen.findByLabelText("Event")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByText("Check-outs have no event")).toBeInTheDocument();
  expect(location.pathname).toBe("/events");
  expect(location.search).toBe("");
});

test("cancelling the event picker stays on Events", async () => {
  navigate("/events");
  renderInShell(<Reservations store={store} />, () => T0);
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(await screen.findByText("Check-outs have no event")).toBeInTheDocument();
  expect(location.pathname).toBe("/events");
});

test("while the picker is open the event rows and New event are not shown", async () => {
  navigate("/events");
  renderInShell(<Reservations store={store} />, () => T0);
  expect(screen.getByRole("button", { name: "New event" })).toBeInTheDocument();
  expect(screen.getByText(/Fall Camp/)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Change" }));
  expect(await screen.findByLabelText("Event")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New event" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Fall Camp/)).not.toBeInTheDocument();
  expect(screen.queryByText("No events.")).not.toBeInTheDocument();
});

test("a pick after a cold load of the event picker lands on Events", async () => {
  history.replaceState({ depth: 0 }, "", "/events?change=1");
  renderInShell(<Reservations store={store} />, () => T0);
  await user.click(await screen.findByRole("button", { name: "No event" }));
  expect(await screen.findByText("Check-outs have no event")).toBeInTheDocument();
  expect(location.pathname).toBe("/events");
  expect(location.search).toBe("");
});

test("an event that cannot be saved shows the error and leaves the picker usable", async () => {
  const db = await openDb("closed", new IDBFactory());
  const broken = await Store.open(db, () => 1);
  db.close();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  navigate("/events?change=1");
  renderInShell(<Reservations store={broken} />, () => T0);
  await user.click(await screen.findByRole("button", { name: "No event" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "No event" })).toBeEnabled();
  expect(location.search).toBe("?change=1");
  logged.mockRestore();
});

test("the menu closes when only the query changes", async () => {
  navigate("/events?change=1");
  const shell: Shell = {
    busy: false,
    manualBusy: false,
    outcome: null,
    now: () => T0,
    sync: async () => undefined,
    syncNow: async () => undefined,
    signOut: async () => {},
    store,
  };
  render(
    <ShellContext value={shell}>
      <Reservations store={store} />
    </ShellContext>,
  );
  await user.click(screen.getByRole("button", { name: "Menu" }));
  expect(screen.getByRole("navigation", { name: "Menu" })).toBeInTheDocument();
  navigate("/events");
  await waitFor(() => expect(screen.queryByRole("navigation", { name: "Menu" })).not.toBeInTheDocument());
});

test("the list says No events only when there are none", async () => {
  navigate("/events");
  const shown = renderInShell(<Reservations store={store} />, () => T0);
  expect(screen.queryByText("No events.")).not.toBeInTheDocument();
  shown.unmount();
  await res.cancelReservation(store, fall);
  renderInShell(<Reservations store={store} />, () => T0);
  expect(screen.getByText("No events.")).toBeInTheDocument();
});

test("the list shows what is ahead, with past camps folded away", async () => {
  await res.createReservation(store, {
    event: "Spring camp",
    starts: "2025-04-10",
    ends: "2025-04-12",
    items: [],
    generics: [],
  });
  navigate("/events");
  renderInShell(<Reservations store={store} />, () => T0);
  expect(screen.getByRole("button", { name: /Fall Camp/ })).toHaveTextContent("2026-10-02 – 2026-10-04 · 2 items");
  expect(screen.getByText("Past (1)")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /Fall Camp/ }));
  expect(location.pathname).toBe(`/events/${fall}`);
});

test("a new reservation is built from one search; an item already booked blocks it (FR-RES-01, FR-RES-05)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  const tarp = await act.createItem(store, { name: "Tarp" });
  await res.addItem(store, fall, stove);

  navigate("/events/new");
  renderInShell(<ReservationForm store={store} />);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

  await user.type(screen.getByLabelText("Event"), "Cub camp");
  await fillDates("2026-10-04", "2026-10-05");
  // A unit never matches by search; searching its number finds nothing here, only single items and generics do.
  await user.type(screen.getByLabelText("Add gear"), "tent #1");
  expect(screen.queryByRole("button", { name: /4-person tent #1/ })).not.toBeInTheDocument();
  await user.clear(screen.getByLabelText("Add gear"));
  await user.type(screen.getByLabelText("Add gear"), "Stove");
  await user.click(screen.getByRole("button", { name: /Stove/ }));
  expect(screen.getByLabelText("Remove Stove")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Already reserved for Fall Camp (Stove).");
  expect(res.reservations(store.state)).toHaveLength(1);

  // Swap the stove for gear that is free, and it saves.
  await user.click(screen.getByLabelText("Remove Stove"));
  await user.type(screen.getByLabelText("Add gear"), "Tarp");
  await user.click(screen.getByRole("button", { name: /Tarp/ }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(res.reservations(store.state).find((r) => r.event === "Cub camp")).toBeDefined());
  const made = res.reservations(store.state).find((r) => r.event === "Cub camp")!;
  expect(made).toMatchObject({ starts: "2026-10-04", ends: "2026-10-05", items: [tarp], generics: [] });
  expect(location.pathname).toBe(`/events/${made.id}`);
});

test("the first date filled fills the other; a date already set is kept", async () => {
  navigate("/events/new");
  renderInShell(<ReservationForm store={store} />);
  await user.type(screen.getByLabelText("Starts"), "2026-10-03");
  expect(screen.getByLabelText("Ends")).toHaveValue("2026-10-03");
  await user.clear(screen.getByLabelText("Ends"));
  await user.type(screen.getByLabelText("Ends"), "2026-10-05");
  expect(screen.getByLabelText("Starts")).toHaveValue("2026-10-03");
});

test("ending before it starts marks the end date until it changes", async () => {
  navigate("/events/new");
  renderInShell(<ReservationForm store={store} />);
  await user.type(screen.getByLabelText("Event"), "Cub camp");
  await fillDates("2026-10-05", "2026-10-03");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("It ends before it starts.");
  expect(screen.getByLabelText("Ends")).toBeInvalid();
  expect(screen.getByLabelText("Starts")).not.toBeInvalid();

  await user.clear(screen.getByLabelText("Ends"));
  await user.type(screen.getByLabelText("Ends"), "2026-10-06");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Ends")).not.toBeInvalid();
});

test("a unit's search surfaces its generic, reserved by count, adjusted in place; too many names the other camp (FR-RES-13, FR-RES-15)", async () => {
  navigate("/events/new");
  renderInShell(<ReservationForm store={store} />);
  await user.type(screen.getByLabelText("Event"), "Cub camp");
  await fillDates("2026-10-03", "2026-10-03");
  await user.type(screen.getByLabelText("Add gear"), "tent");
  await user.click(screen.getByRole("button", { name: /4-person tent/ }));
  const quantity = screen.getByLabelText("How many 4-person tent");
  expect(quantity).toHaveValue(1);
  await user.clear(quantity);
  await user.type(quantity, "2");
  expect(quantity).toHaveValue(2);

  // Fall Camp has one tent by name and one by count; we own two.
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Fall Camp (4 × 4-person tent, we have 2)");
});

test("a calendar feed's event fills the name and the dates when picked (FR-RES-20)", async () => {
  await store.setMeta({
    calendar_events: [
      { uid: "e1", summary: "Spring Camp", starts: "2026-05-01", ends: "2026-05-03", all_day: true },
      { uid: "e2", summary: "Winter Camp", starts: "2026-01-10", ends: "2026-01-12", all_day: true },
    ],
  });
  navigate("/events/new");
  renderInShell(<ReservationForm store={store} />);
  await user.type(screen.getByLabelText("Event"), "spring");
  expect(screen.queryByRole("button", { name: /Winter Camp/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Spring Camp/ }));
  expect(screen.getByLabelText("Event")).toHaveValue("Spring Camp");
  expect(screen.getByLabelText("Starts")).toHaveValue("2026-05-01");
  expect(screen.getByLabelText("Ends")).toHaveValue("2026-05-03");
});

test("duplicate carries the gear and the name over, not the dates (FR-RES-10)", async () => {
  navigate(`/events/new?from=${fall}`);
  renderInShell(<ReservationForm store={store} from={fall} />);
  expect(screen.getByLabelText("Event")).toHaveValue("Fall Camp");
  expect(screen.getByLabelText("Starts")).toHaveValue("");
  expect(screen.getByLabelText("Remove 4-person tent #1")).toBeInTheDocument();
  expect(screen.getByLabelText("How many 4-person tent")).toHaveValue(1);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("the page shows the gear, opens packing on the scan screen without touching the device session, and can cancel (FR-RES-25)", async () => {
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => T0);
  expect(screen.getByRole("heading", { name: "Fall Camp" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /4-person tent #1/ })).toHaveTextContent("Cold locker · In");
  expect(screen.getByText("1 × 4-person tent — 0 packed")).toBeInTheDocument();
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  // Who made it, and when (FR-RES-18): set at replay from the creating event's actor.
  expect(screen.getByText(/^Added by Alice/)).toBeInTheDocument();

  // Packing reads the event from the reservation itself, so nothing is copied into the device's session (FR-RES-25).
  await user.click(screen.getByRole("button", { name: "Check out" }));
  expect(store.meta.session_event).toBeUndefined();
  expect(location.pathname + location.search).toBe(`/scan?reservation=${fall}`);

  await user.click(screen.getByRole("button", { name: "Cancel event" }));
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
  renderInShell(<ReservationPage store={store} id={fall} />, () => T0);
  expect(screen.getByRole("note")).toHaveTextContent("Needed for Cub camp (4-person tent #1).");
});

test("Edit opens the form with the reservation in it and saves changed fields only", async () => {
  navigate(`/events/${fall}`);
  navigate(`/events/${fall}/edit`);
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
  expect(location.pathname).toBe(`/events/${fall}`);
});

test("gear that is out under nothing is claimed from the page in one tap (FR-RES-17, S-RES-07)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  const out = await mv.checkOut(store, t1); // Thursday, no event set
  await checkOutUnplanned(store, stove, "Somebody else's trip");
  navigate(`/events/${fall}`);
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

test("the page marks each line packed or not, and Not packed hides the packed ones (FR-RES-29)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await res.addItem(store, fall, stove);
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => T0);
  const tent = () => screen.queryByRole("button", { name: /4-person tent #1/ });
  // Nothing packed yet: nothing to filter.
  expect(screen.queryByRole("checkbox", { name: "Not packed" })).not.toBeInTheDocument();
  expect(tent()).toHaveTextContent("Not packed");

  await mv.checkOut(store, t1, { event: "Fall Camp", reservation_id: fall });
  await waitFor(() => expect(tent()).toHaveTextContent(/^4-person tent #1Packed/));
  expect(screen.getByRole("button", { name: /Stove/ })).toHaveTextContent("Not packed");
  expect(screen.getByText("1 × 4-person tent — 0 packed")).toBeInTheDocument();

  await user.click(screen.getByRole("checkbox", { name: "Not packed" }));
  expect(tent()).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Stove/ })).toBeInTheDocument();
  expect(screen.getByText("1 × 4-person tent — 0 packed")).toBeInTheDocument();

  // The last unit and the stove go: the filter leaves nothing, and says so.
  await mv.checkOut(store, t2, { event: "Fall Camp", reservation_id: fall });
  await mv.checkOut(store, stove, { event: "Fall Camp", reservation_id: fall });
  await waitFor(() => expect(screen.getByText("Everything is packed.")).toBeInTheDocument());
  expect(screen.queryByText(/× 4-person tent/)).not.toBeInTheDocument();

  await user.click(screen.getByRole("checkbox", { name: "Not packed" }));
  expect(tent()).toBeInTheDocument();
  expect(screen.getByText("1 × 4-person tent — packed")).toBeInTheDocument();
});

test("once the event has ended the page says Not returned, and filters by it (FR-RES-41, FR-RES-42)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await res.addItem(store, fall, stove);
  const later = () => Date.parse("2026-10-10T19:00:00Z");
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, later);
  const row = (name: RegExp) => screen.getByRole("button", { name });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

  const under = { event: "Fall Camp", reservation_id: fall };
  await mv.checkOut(store, t1, under);
  await mv.checkOut(store, stove, under);
  await mv.sendItemHome(store, stove, { cleaner: "Smith" });
  await mv.checkOut(store, t2, under);
  await waitFor(() => expect(row(/4-person tent #1/)).toHaveTextContent("Not returned"));
  expect(row(/Stove/)).toHaveTextContent("Not returned · at home with Smith");
  expect(screen.getByText("1 × 4-person tent — 1 not returned")).toBeInTheDocument();
  expect(screen.queryByText(/Not packed|Packed/)).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Not packed" })).not.toBeInTheDocument();

  await mv.checkIn(store, t1);
  await waitFor(() => expect(row(/4-person tent #1/)).not.toHaveTextContent("Not returned"));
  await user.click(screen.getByRole("checkbox", { name: "Not returned" }));
  expect(screen.queryByRole("button", { name: /4-person tent #1/ })).not.toBeInTheDocument();
  expect(row(/Stove/)).toBeInTheDocument();

  await mv.backFromCleaning(store, stove);
  await mv.checkIn(store, stove);
  await mv.checkIn(store, t2);
  await waitFor(() => expect(screen.getByText("Everything is back.")).toBeInTheDocument());
  expect(screen.queryByText(/× 4-person tent/)).not.toBeInTheDocument();
});

test("an event page keeps its filter and mode through Back, and starts clear when opened afresh", async () => {
  const later = () => Date.parse("2026-10-10T19:00:00Z");
  await mv.checkOut(store, t1, { event: "Fall Camp", reservation_id: fall });
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, later);
  await user.click(await screen.findByRole("checkbox", { name: "Not returned" }));
  await user.click(screen.getByRole("button", { name: "Packing" }));
  expect(screen.getByRole("checkbox", { name: "Not packed" })).toBeChecked();
  cleanup();

  renderInShell(<ReservationPage store={store} id={fall} />, later);
  expect(await screen.findByRole("checkbox", { name: "Not packed" })).toBeChecked();
  expect(screen.getByRole("button", { name: "Packing" })).toHaveAttribute("aria-pressed", "true");
  cleanup();

  navigate("/events");
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, later);
  expect(await screen.findByRole("checkbox", { name: "Not returned" })).not.toBeChecked();
});

test("at a desk, It's with us sits at the end of its row; on a phone, under it", async () => {
  const sheet = document.createElement("style");
  sheet.textContent = readFileSync(join(import.meta.dirname, "../styles.css"), "utf8");
  document.head.append(sheet);
  try {
    await mv.checkOut(store, t1);
    navigate(`/events/${fall}`);
    const row = () => {
      cleanup();
      renderInShell(<ReservationPage store={store} id={fall} />, () => T0);
      return screen.getByLabelText("It's with us: 4-person tent #1").closest("li")!;
    };
    expect(getComputedStyle(row()).display).not.toBe("flex");
    desk();
    expect(getComputedStyle(row()).display).toBe("flex");
  } finally {
    sheet.remove();
  }
});

test("an event with gear out and no reservation becomes one in one tap, offline (FR-RES-28)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await checkOutUnplanned(store, stove, "Apple Day");
  await checkOutUnplanned(store, t2, "apple day");
  await store.setMeta({
    calendar_events: [{ uid: "e1", summary: "Apple Day", starts: "2025-08-31", ends: "2025-09-02", all_day: true }],
  });
  navigate("/events");
  renderInShell(<Reservations store={store} />, () => T0);
  expect(screen.getByText("Apple Day")).toBeInTheDocument();
  expect(screen.getByText("2025-08-31 – 2025-09-02 · 2 items out")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Add Apple Day" }));
  await waitFor(() => expect(location.pathname).toMatch(/^\/events\/\w+$/));
  const id = location.pathname.split("/").at(-1)!;
  expect(res.reservation(store.state, id)).toMatchObject({ event: "Apple Day", items: [t2, stove] });
  expect(inv.item(store.state, stove)?.movement).toMatchObject({ event: "Apple Day", reservation_id: id });
  expect(store.pending.filter((e) => e.type === "checked_out" || e.type === "checked_in")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Add Apple Day" })).not.toBeInTheDocument();
});

test("an event with only counted gear out is listed, and Add brings it in (FR-RES-28)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 10);
  await checkOutUnplanned(store, bowls, "Apple Day", 4);
  navigate("/events");
  renderInShell(<Reservations store={store} />, () => T0);
  expect(screen.getByText(/4 items out/)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Add Apple Day" }));
  await waitFor(() => expect(location.pathname).toMatch(/^\/events\/\w+$/));
  const id = location.pathname.split("/").at(-1)!;
  expect(res.reservation(store.state, id)?.generics).toEqual([{ item_id: bowls, quantity: 4 }]);
});

test("a camp within seven days of another sharing gear gets a muted hint, not a block (FR-RES-19)", async () => {
  await res.createReservation(store, {
    event: "Winter Prep",
    starts: "2026-10-08",
    ends: "2026-10-09",
    items: [],
    generics: [{ item_id: tents, quantity: 1 }],
  });
  navigate(`/events/${fall}`);
  // Fall Camp ends 2026-10-04; Winter Prep starts four days later: near, but not overlapping.
  renderInShell(<ReservationPage store={store} id={fall} />, () => T0);
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  expect(screen.getByText("Needed for Winter Prep, 2026-10-08 – 2026-10-09")).toBeInTheDocument();
});

test("a pool line on the page is checked out by count, and ticks off (FR-RES-13)", async () => {
  const bowls = newUlid();
  await store.record({
    entity_type: "item",
    entity_id: bowls,
    type: "created",
    actor_id: "alice",
    payload: { name: "Bowls", generic: true, pool: true, quantity: 10 },
  });
  const camp = await res.createReservation(store, {
    event: "Cub camp",
    starts: "2026-11-01",
    ends: "2026-11-02",
    items: [],
    generics: [{ item_id: bowls, quantity: 4 }],
  });
  navigate(`/events/${camp}`);
  renderInShell(<ReservationPage store={store} id={camp} />, () => T0);

  expect(screen.getByText("4 × Bowls — 0 packed")).toBeInTheDocument();
  const count = screen.getByLabelText("How many Bowls to check out");
  expect(count).toHaveValue(4);
  await user.click(screen.getByRole("button", { name: "Check out Bowls" }));

  await waitFor(() => expect(screen.getByText("4 × Bowls — packed")).toBeInTheDocument());
  expect(inv.poolCounts(inv.item(store.state, bowls)!)).toMatchObject({
    owned: 10,
    in: 6,
    out: [{ holder_id: "alice", count: 4 }],
  });
  // Fully checked off: the count and its button are gone.
  expect(screen.queryByLabelText("How many Bowls to check out")).not.toBeInTheDocument();
});

test("a pool line starts at what is in, and shows the refusal inline past it (FR-OUT-55)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 3);
  const camp = await res.createReservation(store, {
    event: "Cub camp",
    starts: "2026-11-01",
    ends: "2026-11-02",
    items: [],
    generics: [{ item_id: bowls, quantity: 4 }],
  });
  navigate(`/events/${camp}`);
  renderInShell(<ReservationPage store={store} id={camp} />, () => T0);

  const count = screen.getByLabelText("How many Bowls to check out");
  expect(count).toHaveValue(3);
  await user.clear(count);
  await user.type(count, "4");
  await user.click(screen.getByRole("button", { name: "Check out Bowls" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/only 3 in/i);
  expect(inv.item(store.state, bowls)?.pool_in).toBe(3);
  await user.type(count, "0");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("the refusal offers Recount, which goes to the pool's page", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 3);
  const camp = await res.createReservation(store, {
    event: "Cub camp",
    starts: "2026-11-01",
    ends: "2026-11-02",
    items: [],
    generics: [{ item_id: bowls, quantity: 4 }],
  });
  navigate(`/events/${camp}`);
  renderInShell(<ReservationPage store={store} id={camp} />, () => T0);

  const count = screen.getByLabelText("How many Bowls to check out");
  await user.clear(count);
  await user.type(count, "4");
  await user.click(screen.getByRole("button", { name: "Check out Bowls" }));
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "Recount" }));
  expect(location.pathname).toBe(`/items/${bowls}`);
});

test("a pool line that said None in offers the count again when stock comes back", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 3);
  await mv.checkOutPool(store, bowls, { count: 3 });
  const camp = await res.createReservation(store, {
    event: "Cub camp",
    starts: "2026-11-01",
    ends: "2026-11-02",
    items: [],
    generics: [{ item_id: bowls, quantity: 4 }],
  });
  navigate(`/events/${camp}`);
  renderInShell(<ReservationPage store={store} id={camp} />, () => T0);
  expect(screen.getByText("None in")).toBeInTheDocument();

  await mv.checkInPool(store, bowls, { count: 2 });
  const count = await screen.findByLabelText("How many Bowls to check out");
  expect(count).toHaveValue(2);
  await user.click(screen.getByRole("button", { name: "Check out Bowls" }));
  await waitFor(() => expect(inv.item(store.state, bowls)?.pool_in).toBe(0));
});

test("a pool line says None in when none are in (FR-OUT-55)", async () => {
  const bowls = await act.createPool(store, { name: "Bowls" }, 3);
  await mv.checkOutPool(store, bowls, { count: 3 });
  const camp = await res.createReservation(store, {
    event: "Cub camp",
    starts: "2026-11-01",
    ends: "2026-11-02",
    items: [],
    generics: [{ item_id: bowls, quantity: 4 }],
  });
  navigate(`/events/${camp}`);
  renderInShell(<ReservationPage store={store} id={camp} />, () => T0);

  expect(screen.getByText("None in")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check out Bowls" })).not.toBeInTheDocument();
});

test("a retired pool line on the page offers no check-out, only a note (FR-INV-04)", async () => {
  const bowls = newUlid();
  await store.record({
    entity_type: "item",
    entity_id: bowls,
    type: "created",
    actor_id: "alice",
    payload: { name: "Bowls", generic: true, pool: true, quantity: 10 },
  });
  await act.retireItem(store, bowls);
  const camp = await res.createReservation(store, {
    event: "Cub camp",
    starts: "2026-11-01",
    ends: "2026-11-02",
    items: [],
    generics: [{ item_id: bowls, quantity: 4 }],
  });
  navigate(`/events/${camp}`);
  renderInShell(<ReservationPage store={store} id={camp} />, () => T0);

  expect(screen.getByText("4 × Bowls — 0 packed")).toBeInTheDocument();
  expect(screen.queryByLabelText("How many Bowls to check out")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Check out Bowls" })).not.toBeInTheDocument();
  expect(screen.getByText("Retired")).toBeInTheDocument();
});

test("a deleted item is not counted as unpacked, and the filter can be untied once on (FR-RES-30)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await res.addItem(store, fall, stove);
  await act.deleteItem(store, stove);
  await mv.checkOut(store, t1, { event: "Fall Camp", reservation_id: fall });
  await mv.checkOut(store, t2, { event: "Fall Camp", reservation_id: fall });
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => T0);

  await user.click(screen.getByRole("checkbox", { name: "Not packed" }));
  expect(screen.getByText("Everything is packed.")).toBeInTheDocument();
  expect(screen.queryByText(/Not packed ·/)).not.toBeInTheDocument();
  // Unpacking everything leaves the box to untick.
  await mv.checkIn(store, t1);
  await mv.checkIn(store, t2);
  await user.click(screen.getByRole("checkbox", { name: "Not packed" }));
  expect(screen.getByRole("button", { name: /4-person tent #1/ })).toHaveTextContent("Not packed");
});

test("a line whose item this device has no record of stays under Not packed (FR-RES-30)", async () => {
  await res.addItem(store, fall, newUlid());
  await mv.checkOut(store, t1, { event: "Fall Camp", reservation_id: fall });
  await mv.checkOut(store, t2, { event: "Fall Camp", reservation_id: fall });
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => T0);

  await user.click(screen.getByRole("checkbox", { name: "Not packed" }));
  expect(screen.getByText("(unknown item)")).toBeInTheDocument();
  expect(screen.queryByText("Everything is packed.")).not.toBeInTheDocument();
});

test("the Packing / Returning switch starts on the first day and defaults to Packing until the last day is over (FR-RES-43)", async () => {
  navigate(`/events/${fall}`);
  const view = renderInShell(<ReservationPage store={store} id={fall} />, () => T0);
  expect(screen.queryByRole("button", { name: "Returning" })).not.toBeInTheDocument();
  view.unmount();

  await mv.checkOut(store, t1, { event: "Fall Camp", reservation_id: fall });
  const lastDay = () => Date.parse("2026-10-04T19:00:00Z");
  renderInShell(<ReservationPage store={store} id={fall} />, lastDay);
  expect(screen.getByRole("button", { name: "Packing" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /4-person tent #1/ })).toHaveTextContent("Packed");
  await user.click(screen.getByRole("button", { name: "Returning" }));
  expect(screen.getByRole("button", { name: /4-person tent #1/ })).toHaveTextContent("Not returned");
  expect(screen.getByRole("checkbox", { name: "Not returned" })).toBeInTheDocument();
});

test("after the end the switch defaults to Returning, and Packing shows Not packed again (FR-RES-44)", async () => {
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => Date.parse("2026-10-10T19:00:00Z"));
  expect(screen.getByRole("button", { name: "Returning" })).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "Packing" }));
  expect(screen.getByRole("button", { name: /4-person tent #1/ })).toHaveTextContent("Not packed");
});

test("an ended event in Packing mode offers no pool check-out", async () => {
  const bowls = newUlid();
  await store.record({
    entity_type: "item",
    entity_id: bowls,
    type: "created",
    actor_id: "alice",
    payload: { name: "Bowls", generic: true, pool: true, quantity: 10 },
  });
  const camp = await res.createReservation(store, {
    event: "Old Camp",
    starts: "2026-09-01",
    ends: "2026-09-02",
    items: [],
    generics: [{ item_id: bowls, quantity: 4 }],
  });
  navigate(`/events/${camp}`);
  renderInShell(<ReservationPage store={store} id={camp} />, () => Date.parse("2026-10-10T19:00:00Z"));
  await user.click(screen.getByRole("button", { name: "Packing" }));
  expect(screen.getByText("4 × Bowls — 0 packed")).toBeInTheDocument();
  expect(screen.queryByLabelText("How many Bowls to check out")).not.toBeInTheDocument();
});

test("a running event switched to Returning offers no pool check-out", async () => {
  const bowls = newUlid();
  await store.record({
    entity_type: "item",
    entity_id: bowls,
    type: "created",
    actor_id: "alice",
    payload: { name: "Bowls", generic: true, pool: true, quantity: 10 },
  });
  const camp = await res.createReservation(store, {
    event: "Running Camp",
    starts: "2026-10-01",
    ends: "2026-10-05",
    items: [],
    generics: [{ item_id: bowls, quantity: 4 }],
  });
  navigate(`/events/${camp}`);
  renderInShell(<ReservationPage store={store} id={camp} />, () => Date.parse("2026-10-03T19:00:00Z"));
  expect(screen.getByLabelText("How many Bowls to check out")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Returning" }));
  expect(screen.queryByLabelText("How many Bowls to check out")).not.toBeInTheDocument();
});

test("a cancelled event has no Packing / Returning switch", async () => {
  await res.cancelReservation(store, fall);
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => Date.parse("2026-10-04T19:00:00Z"));
  expect(screen.queryByRole("button", { name: "Returning" })).not.toBeInTheDocument();
});

test("on an ended event, a line whose item this device has no record of stays under Not returned", async () => {
  await res.addItem(store, fall, newUlid());
  await mv.checkOut(store, t1, { event: "Fall Camp", reservation_id: fall });
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => Date.parse("2026-10-10T19:00:00Z"));

  await user.click(screen.getByRole("checkbox", { name: "Not returned" }));
  expect(screen.getByText("(unknown item)")).toBeInTheDocument();
  expect(screen.queryByText("Everything is back.")).not.toBeInTheDocument();
});

test("a cancelled reservation marks nothing packed and offers no filter (FR-RES-29)", async () => {
  await mv.checkOut(store, t1, { event: "Fall Camp", reservation_id: fall });
  await res.cancelReservation(store, fall);
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => T0);
  expect(screen.getByRole("button", { name: /4-person tent #1/ })).not.toHaveTextContent("Packed");
  expect(screen.getByText("1 × 4-person tent")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Not packed" })).not.toBeInTheDocument();
});

test("gear out under the camp's name but not packing it is offered It's with us (FR-RES-17)", async () => {
  await checkOutUnplanned(store, t1, "Fall Camp"); // a plain scan, no reservation
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => T0);
  expect(screen.getByRole("button", { name: /^4-person tent #1/ })).toHaveTextContent("Not packed");

  await user.click(screen.getByLabelText("It's with us: 4-person tent #1"));
  await waitFor(() => expect(screen.getByRole("button", { name: /^4-person tent #1/ })).toHaveTextContent(/Packed/));
  expect(inv.item(store.state, t1)?.movement).toMatchObject({ reservation_id: fall });
  expect(screen.queryByLabelText("It's with us: 4-person tent #1")).not.toBeInTheDocument();
});

test("gear a reservation from an event could not link is named until it is linked (FR-RES-31)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await res.addItem(store, fall, stove);
  await checkOutUnplanned(store, stove, "Apple Day");
  navigate(`/events/${fall}?unlinked=${stove}`);
  renderInShell(<ReservationPage store={store} id={fall} unlinked={stove} />, () => T0);
  expect(screen.getByRole("alert")).toHaveTextContent("Not linked: Stove.");

  await user.click(screen.getByLabelText("It's with us: Stove"));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});

test("when nothing linked, the page gives the reason instead (FR-RES-31)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await res.addItem(store, fall, stove);
  await checkOutUnplanned(store, stove, "Apple Day");
  navigate(`/events/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} unlinked={stove} why="not signed in" />, () => T0);
  expect(screen.getByRole("alert")).toHaveTextContent(/^not signed in$/);
});

test("an event's gear lists are in alphabetical order by name, also under Not packed (FR-RES-37)", async () => {
  const zebra = await act.createItem(store, { name: "Zebra tarp" });
  const apple = await act.createItem(store, { name: "Apple press" });
  const mango = await act.createItem(store, { name: "Mango stove" });
  const pots = await act.createGeneric(store, { name: "Pots" });
  const axes = await act.createGeneric(store, { name: "Axes" });
  const order = await res.createReservation(store, {
    event: "Order camp",
    starts: "2026-11-02",
    ends: "2026-11-04",
    items: [zebra, apple, mango],
    generics: [
      { item_id: pots, quantity: 1 },
      { item_id: axes, quantity: 2 },
    ],
  });
  navigate(`/events/${order}`);
  renderInShell(<ReservationPage store={store} id={order} />, () => T0);
  const names = () => [...document.querySelectorAll(".items .item-name")].map((e) => e.textContent);
  const generics = () => [...document.querySelectorAll(".names .name")].map((e) => e.textContent?.split(" — ")[0]);
  expect(names()).toEqual(["Apple press", "Mango stove", "Zebra tarp"]);
  expect(generics()).toEqual(["2 × Axes", "1 × Pots"]);

  await mv.checkOut(store, mango, { event: "Order camp", reservation_id: order });
  await user.click(await screen.findByRole("checkbox", { name: "Not packed" }));
  expect(names()).toEqual(["Apple press", "Zebra tarp"]);
  expect(generics()).toEqual(["2 × Axes", "1 × Pots"]);
  expect(res.reservation(store.state, order)?.items).toEqual([zebra, apple, mango]);
});

test("units numbered 2 and 10 list 2 first on the event page, the edit form and the packing list (FR-RES-37)", async () => {
  const tents = await act.createGeneric(store, { name: "Tent" });
  const ten = await act.addUnit(store, tents, "10");
  const two = await act.addUnit(store, tents, "2");
  const pots = await act.createGeneric(store, { name: "Pots" });
  const axes = await act.createGeneric(store, { name: "Axes" });
  const order = await res.createReservation(store, {
    event: "Number camp",
    starts: "2026-11-02",
    ends: "2026-11-04",
    items: [ten, two],
    generics: [
      { item_id: pots, quantity: 1 },
      { item_id: axes, quantity: 1 },
    ],
  });
  expect(res.remaining(store.state, res.reservation(store.state, order)!).generics.map((g) => g.generic.name)).toEqual([
    "Axes",
    "Pots",
  ]);

  navigate(`/events/${order}`);
  renderInShell(<ReservationPage store={store} id={order} />, () => T0);
  expect([...document.querySelectorAll(".items .item-name")].map((e) => e.textContent)).toEqual([
    "Tent #2",
    "Tent #10",
  ]);
  cleanup();

  navigate(`/events/${order}/edit`);
  renderInShell(<ReservationForm store={store} id={order} />);
  expect([...document.querySelectorAll(".names .name")].map((e) => e.textContent)).toEqual([
    "Tent #2",
    "Tent #10",
    "Axes",
    "Pots",
  ]);
  expect(res.reservation(store.state, order)?.items).toEqual([ten, two]);
});
