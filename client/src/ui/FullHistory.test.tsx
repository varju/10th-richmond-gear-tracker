import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { createApi, type ServerEvent } from "../lib/api";
import * as mv from "../lib/movement";
import * as rep from "../lib/repairs";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { ItemPage } from "./ItemPage";
import { alice, renderInShell, seedUsers } from "./moveTestKit";
import { Repairs } from "./Repairs";

// The whole record when there is signal, this device's 90 days when there is not (FR-INV-31).
const T0 = 1_756_684_800_000;
const LONG_AGO = 1_572_652_800_000; // 2019-11-02, well past what a device keeps.

let store: Store;
let tent: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
  tent = await act.createItem(store, { name: "Tent 1" });
});

let n = 0;
const serverEvent = (over: Partial<ServerEvent>): ServerEvent => ({
  id: `0300000000000000000000${String(++n).padStart(4, "0")}`,
  entity_type: "item",
  entity_id: tent,
  type: "checked_in",
  actor_id: "alice",
  device_id: "old-phone",
  device_seq: n,
  occurred_at: LONG_AGO,
  clock_offset: 0,
  effective_at: LONG_AGO,
  received_at: LONG_AGO,
  seq: n,
  payload: {},
  ...over,
});

/** A server that answers /history with these events, and nothing else. */
function serving(events: ServerEvent[]) {
  const asked: string[] = [];
  const api = createApi({
    token: () => "t",
    fetch: async (input) => {
      const path = String(input);
      asked.push(path);
      const mine = events.filter(
        (e) => path.endsWith(`/${e.entity_type}/${e.entity_id}`) || path.endsWith(`/${e.entity_type}`),
      );
      return new Response(JSON.stringify({ events: mine, server_time: T0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { api, asked };
}

/** A server that cannot be reached, which is the normal case in a locker. */
const unreachable = createApi({
  token: () => "t",
  fetch: async () => {
    throw new TypeError("Failed to fetch");
  },
});

// History's Add note sits above the list now, so the list itself is not the summary's next sibling.
const historyList = () =>
  screen
    .getByRole("heading", { name: /^History(?: ·|$)/ })
    .closest("details")!
    .querySelector("ol.history") as HTMLElement;

test("an item's history and changes come from the server, with what this device has not sent", async () => {
  // Recorded here and not yet pushed: it must not vanish when the signal returns.
  await mv.checkOut(store, tent, { event: "Fall Camp" });
  const { api, asked } = serving([
    serverEvent({
      type: "checked_out",
      payload: { holder_id: "alice", event: "Winter Camp 2019" },
    }),
    serverEvent({ type: "checked_in" }),
    serverEvent({
      type: "field_changed",
      payload: { field: "name", value: "Tent 1", old: "Old tent" },
    }),
  ]);
  renderInShell(<ItemPage store={store} id={tent} />, () => T0, api);

  await waitFor(() => expect(screen.getByText(/Winter Camp 2019/)).toBeInTheDocument());
  fireEvent.click(screen.getByText(/^History/));
  expect(within(historyList()).getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText(/for Fall Camp/)).toBeInTheDocument();
  expect(screen.getByText(/Name: Old tent → Tent 1/)).toBeInTheDocument();
  // The full record, so there is nothing to warn about.
  expect(screen.queryByText(/last 90 days/)).not.toBeInTheDocument();
  // One ask for the page, not one per block.
  expect(asked).toEqual([`/history/item/${tent}`]);
});

test("with no answer from the server the same rows are drawn from this device, and say so", async () => {
  await mv.checkOut(store, tent, { event: "Fall Camp" });
  renderInShell(<ItemPage store={store} id={tent} />, () => T0, unreachable);

  await waitFor(() => expect(screen.getByText(/for Fall Camp/)).toBeInTheDocument());
  fireEvent.click(screen.getByText(/^History/));
  expect(within(historyList()).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getAllByText("Offline: what this device knows, the last 90 days.")).toHaveLength(2);
});

test("a device that knows it is offline does not ask", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const { api, asked } = serving([
    serverEvent({
      type: "checked_out",
      payload: { event: "Winter Camp 2019" },
    }),
  ]);
  renderInShell(<ItemPage store={store} id={tent} />, () => T0, api);

  await screen.findByRole("heading", { name: /^History/ });
  expect(asked).toEqual([]);
  expect(screen.queryByText(/Winter Camp 2019/)).not.toBeInTheDocument();
  vi.restoreAllMocks();
});

test("an event the server already has is not shown twice", async () => {
  await mv.checkOut(store, tent, { event: "Fall Camp" });
  const mine = store.eventsFor("item", tent).find((e) => e.type === "checked_out")!;
  const { api } = serving([serverEvent({ ...mine, seq: 1, received_at: T0 })]);
  renderInShell(<ItemPage store={store} id={tent} />, () => T0, api);

  await waitFor(() => expect(screen.getByText(/for Fall Camp/)).toBeInTheDocument());
  fireEvent.click(screen.getByText(/^History/));
  expect(within(historyList()).getAllByRole("listitem")).toHaveLength(1);
});

test("the repair report reads every ticket the server holds", async () => {
  const tarp = await act.createItem(store, { name: "Old tarp" });
  await rep.raiseTicket(store, tent, "torn fly");
  const { api, asked } = serving([
    serverEvent({
      entity_type: "repair",
      entity_id: "old-ticket",
      type: "created",
      payload: { item_id: tarp, description: "bent pole" },
    }),
  ]);
  renderInShell(<Repairs store={store} />, () => T0, api);

  const history = () => screen.getByRole("region", { name: "History" });
  await waitFor(() => expect(within(history()).queryByText(/last 90 days/)).not.toBeInTheDocument());
  expect(asked).toEqual(["/history/repair"]);

  // A 2019 ticket is outside the last 30 days the report opens on. Widen it.
  fireEvent.change(within(history()).getByLabelText("From"), {
    target: { value: "2019-01-01" },
  });
  expect(within(history()).getByText("Old tarp")).toBeInTheDocument();
  // This device's own ticket is still there, unsent and all.
  expect(within(history()).getByText("Tent 1")).toBeInTheDocument();
});

test("the repair report falls back to this device and says so", async () => {
  await rep.raiseTicket(store, tent, "torn fly");
  renderInShell(<Repairs store={store} />, () => T0, unreachable);

  const history = () => screen.getByRole("region", { name: "History" });
  await waitFor(() =>
    expect(within(history()).getByText("Offline: what this device knows, the last 90 days.")).toBeInTheDocument(),
  );
});
