import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import * as inv from "../lib/inventory";
import * as mv from "../lib/movement";
import * as res from "../lib/reservations";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
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

test("a new reservation is built from one search; an item already booked blocks it (FR-RES-01, FR-RES-05)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  const tarp = await act.createItem(store, { name: "Tarp" });
  await res.addItem(store, fall, stove);

  navigate("/reservations/new");
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
  expect(location.pathname).toBe(`/reservations/${made.id}`);
});

test("the first date filled fills the other; a date already set is kept", async () => {
  navigate("/reservations/new");
  renderInShell(<ReservationForm store={store} />);
  await user.type(screen.getByLabelText("Starts"), "2026-10-03");
  expect(screen.getByLabelText("Ends")).toHaveValue("2026-10-03");
  await user.clear(screen.getByLabelText("Ends"));
  await user.type(screen.getByLabelText("Ends"), "2026-10-05");
  expect(screen.getByLabelText("Starts")).toHaveValue("2026-10-03");
});

test("ending before it starts marks the end date until it changes", async () => {
  navigate("/reservations/new");
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
  navigate("/reservations/new");
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
  navigate("/reservations/new");
  renderInShell(<ReservationForm store={store} />);
  await user.type(screen.getByLabelText("Event"), "spring");
  expect(screen.queryByRole("button", { name: /Winter Camp/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Spring Camp/ }));
  expect(screen.getByLabelText("Event")).toHaveValue("Spring Camp");
  expect(screen.getByLabelText("Starts")).toHaveValue("2026-05-01");
  expect(screen.getByLabelText("Ends")).toHaveValue("2026-05-03");
});

test("duplicate carries the gear and the name over, not the dates (FR-RES-10)", async () => {
  navigate(`/reservations/new?from=${fall}`);
  renderInShell(<ReservationForm store={store} from={fall} />);
  expect(screen.getByLabelText("Event")).toHaveValue("Fall Camp");
  expect(screen.getByLabelText("Starts")).toHaveValue("");
  expect(screen.getByLabelText("Remove 4-person tent #1")).toBeInTheDocument();
  expect(screen.getByLabelText("How many 4-person tent")).toHaveValue(1);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("the page shows the gear, opens packing on the scan screen without touching the device session, and can cancel (FR-RES-25)", async () => {
  navigate(`/reservations/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />);
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
  expect(screen.getByRole("note")).toHaveTextContent("Needed for Cub camp (4-person tent #1).");
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

test("the page marks each line packed or not, and Not packed hides the packed ones (FR-RES-29)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await res.addItem(store, fall, stove);
  navigate(`/reservations/${fall}`);
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
  expect(screen.getByText("1 × 4-person tent — 1 packed")).toBeInTheDocument();
});

test("at a desk, It's with us sits at the end of its row; on a phone, under it", async () => {
  const sheet = document.createElement("style");
  sheet.textContent = readFileSync(join(import.meta.dirname, "../styles.css"), "utf8");
  document.head.append(sheet);
  try {
    await mv.checkOut(store, t1);
    navigate(`/reservations/${fall}`);
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
  await mv.checkOut(store, stove, { event: "Apple Day" });
  await mv.checkOut(store, t2, { event: "apple day" });
  await store.setMeta({
    calendar_events: [{ uid: "e1", summary: "Apple Day", starts: "2025-08-31", ends: "2025-09-02", all_day: true }],
  });
  navigate("/reservations");
  renderInShell(<Reservations store={store} />, () => T0);
  expect(screen.getByText("Out with no reservation")).toBeInTheDocument();
  expect(screen.getByText("2025-08-31 – 2025-09-02 · 2 items out")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Reserve Apple Day" }));
  await waitFor(() => expect(location.pathname).toMatch(/^\/reservations\/\w+$/));
  const id = location.pathname.split("/").at(-1)!;
  expect(res.reservation(store.state, id)).toMatchObject({ event: "Apple Day", items: [t2, stove] });
  expect(inv.item(store.state, stove)?.movement).toMatchObject({ event: "Apple Day", reservation_id: id });
  expect(store.pending.filter((e) => e.type === "checked_out" || e.type === "checked_in")).toHaveLength(2);
  expect(screen.queryByText("Out with no reservation")).not.toBeInTheDocument();
});

test("a camp within seven days of another sharing gear gets a muted hint, not a block (FR-RES-19)", async () => {
  await res.createReservation(store, {
    event: "Winter Prep",
    starts: "2026-10-08",
    ends: "2026-10-09",
    items: [],
    generics: [{ item_id: tents, quantity: 1 }],
  });
  navigate(`/reservations/${fall}`);
  // Fall Camp ends 2026-10-04; Winter Prep starts four days later: near, but not overlapping.
  renderInShell(<ReservationPage store={store} id={fall} />);
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
  navigate(`/reservations/${camp}`);
  renderInShell(<ReservationPage store={store} id={camp} />);

  expect(screen.getByText("4 × Bowls — 0 packed")).toBeInTheDocument();
  const count = screen.getByLabelText("How many Bowls to check out");
  expect(count).toHaveValue(4);
  await user.click(screen.getByRole("button", { name: "Check out Bowls" }));

  await waitFor(() => expect(screen.getByText("4 × Bowls — 4 packed")).toBeInTheDocument());
  expect(inv.poolCounts(inv.item(store.state, bowls)!)).toMatchObject({
    owned: 10,
    in: 6,
    out: [{ holder_id: "alice", count: 4 }],
  });
  // Fully checked off: the count and its button are gone.
  expect(screen.queryByLabelText("How many Bowls to check out")).not.toBeInTheDocument();
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
  navigate(`/reservations/${camp}`);
  renderInShell(<ReservationPage store={store} id={camp} />);

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
  navigate(`/reservations/${fall}`);
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
  navigate(`/reservations/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => T0);

  await user.click(screen.getByRole("checkbox", { name: "Not packed" }));
  expect(screen.getByText("(unknown item)")).toBeInTheDocument();
  expect(screen.queryByText("Everything is packed.")).not.toBeInTheDocument();
});

test("a cancelled reservation marks nothing packed and offers no filter (FR-RES-29)", async () => {
  await mv.checkOut(store, t1, { event: "Fall Camp", reservation_id: fall });
  await res.cancelReservation(store, fall);
  navigate(`/reservations/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} />, () => T0);
  expect(screen.getByRole("button", { name: /4-person tent #1/ })).not.toHaveTextContent("Packed");
  expect(screen.getByText("1 × 4-person tent")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Not packed" })).not.toBeInTheDocument();
});

test("gear out under the camp's name but not packing it is offered It's with us (FR-RES-17)", async () => {
  await mv.checkOut(store, t1, { event: "Fall Camp" }); // a plain scan, no reservation
  navigate(`/reservations/${fall}`);
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
  await mv.checkOut(store, stove, { event: "Apple Day" });
  navigate(`/reservations/${fall}?unlinked=${stove}`);
  renderInShell(<ReservationPage store={store} id={fall} unlinked={stove} />, () => T0);
  expect(screen.getByRole("alert")).toHaveTextContent("Not linked: Stove.");

  await user.click(screen.getByLabelText("It's with us: Stove"));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});

test("when nothing linked, the page gives the reason instead (FR-RES-31)", async () => {
  const stove = await act.createItem(store, { name: "Stove" });
  await res.addItem(store, fall, stove);
  await mv.checkOut(store, stove, { event: "Apple Day" });
  navigate(`/reservations/${fall}`);
  renderInShell(<ReservationPage store={store} id={fall} unlinked={stove} why="not signed in" />, () => T0);
  expect(screen.getByRole("alert")).toHaveTextContent(/^not signed in$/);
});
