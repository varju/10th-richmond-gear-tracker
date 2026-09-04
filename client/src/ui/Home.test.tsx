import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, test } from "vitest";
import { DAY_MS } from "../lib/clock";
import { openDb } from "../lib/db";
import { cancelReservation, createReservation } from "../lib/reservations";
import { navigate } from "../lib/router";
import { Store } from "../lib/store";
import { localDate } from "../lib/time";
import { Home } from "./Home";
import { renderInShell } from "./moveTestKit";

const T0 = 1_756_684_800_000;
let store: Store;

beforeEach(async () => {
  navigate("/");
  store = await Store.open(await openDb("home", new IDBFactory()), () => T0);
  await store.setMeta({ user: { id: "alice", name: "Alice", role: "admin", active: true } });
});

const mount = () => renderInShell(<Home store={store} />, () => T0);
const in_ = (days: number) => localDate(T0 + days * DAY_MS);

test("lists reservations under way or starting within seven days, ordered by start; one tap starts packing (FR-RES-21)", async () => {
  const underWay = await createReservation(store, {
    event: "Fall Camp",
    starts: in_(0),
    ends: in_(2),
    items: [],
    generics: [],
  });
  await createReservation(store, { event: "Weekend Camp", starts: in_(5), ends: in_(6), items: [], generics: [] });
  await createReservation(store, { event: "Far Camp", starts: in_(10), ends: in_(11), items: [], generics: [] });
  await createReservation(store, { event: "Old Camp", starts: in_(-5), ends: in_(-3), items: [], generics: [] });
  const cancelled = await createReservation(store, {
    event: "Called Off",
    starts: in_(0),
    ends: in_(0),
    items: [],
    generics: [],
  });
  await cancelReservation(store, cancelled);

  mount();
  const ready = screen.getByRole("region", { name: "Ready to pack" });
  const rows = within(ready).getAllByRole("button");
  expect(rows.map((b) => b.textContent)).toEqual([
    `Fall Camp${in_(0)} – ${in_(2)}`,
    `Weekend Camp${in_(5)} – ${in_(6)}`,
  ]);
  expect(screen.queryByText("Far Camp")).not.toBeInTheDocument();
  expect(screen.queryByText("Old Camp")).not.toBeInTheDocument();
  expect(screen.queryByText("Called Off")).not.toBeInTheDocument();

  await userEvent.setup().click(within(ready).getByRole("button", { name: /Fall Camp/ }));
  expect(location.pathname + location.search).toBe(`/scan?mode=out&reservation=${underWay}`);
});

test("nothing is shown when there is nothing to pack soon", async () => {
  await createReservation(store, { event: "Far Camp", starts: in_(10), ends: in_(11), items: [], generics: [] });
  mount();
  expect(screen.queryByRole("region", { name: "Ready to pack" })).not.toBeInTheDocument();
});

test("today is still visible unhindered when nothing is coming up", async () => {
  mount();
  expect(screen.queryByRole("region", { name: "Ready to pack" })).not.toBeInTheDocument();
  expect(
    screen.getByText("Check out or return gear by scanning its code. Search by name for gear with no sticker."),
  ).toBeInTheDocument();
});
