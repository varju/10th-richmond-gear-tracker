import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import type { ServerEvent } from "../lib/api";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { Found } from "./Found";
import { Inventory } from "./Inventory";

// Found reports reach the Quartermaster in the app, as something to act on (FR-PUB-03).
const T0 = 1_756_684_800_000;
let store: Store;
let tent: string;

function reported(id: string, note: string, item_id: string | null, contact = ""): ServerEvent {
  const at = T0 + Number(id.slice(-2));
  return {
    id,
    entity_type: "found_report",
    entity_id: id,
    type: "created",
    actor_id: "public",
    device_id: "server",
    device_seq: at,
    occurred_at: at,
    clock_offset: 0,
    effective_at: at,
    received_at: at,
    seq: at,
    payload: { code: "BBBBBBBBBB", item_id, note, contact },
  };
}

beforeEach(async () => {
  store = await openStore();
  tent = await act.createItem(store, { name: "Tent 1" });
  navigate("/found");
});

const user = userEvent.setup();

test("each report names the item, quotes the finder, and can be resolved", async () => {
  await store.receive(
    [
      reported("01000000000000000000000001", "by the gate", tent, "finder@example.org"),
      reported("01000000000000000000000002", "left in the car park", null),
    ],
    2,
  );
  render(<Found store={store} />);

  const first = screen.getByRole("region", { name: "Tent 1" });
  expect(first).toHaveTextContent("by the gate");
  expect(within(first).getByRole("link", { name: "finder@example.org" })).toHaveAttribute(
    "href",
    "mailto:finder@example.org",
  );
  expect(first).toHaveTextContent("Reported 2025-09-01");
  // A sticker not yet on anything is named by its code.
  expect(screen.getByRole("region", { name: "BBBBBBBBBB" })).toHaveTextContent("left in the car park");

  await user.click(within(first).getByRole("button", { name: "Resolve" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Tent 1" })).not.toBeInTheDocument());
  expect(store.pending.at(-1)).toMatchObject({
    entity_type: "found_report",
    entity_id: "01000000000000000000000001",
    type: "field_changed",
    payload: { field: "resolved", value: true },
  });

  await user.click(within(screen.getByRole("region", { name: "BBBBBBBBBB" })).getByRole("button", { name: "Resolve" }));
  expect(await screen.findByText("No found reports.")).toBeInTheDocument();
});

test("the item's name opens the item", async () => {
  await store.receive([reported("01000000000000000000000001", "by the gate", tent)], 1);
  render(<Found store={store} />);
  await user.click(screen.getByRole("button", { name: "Tent 1" }));
  expect(location.pathname).toBe(`/items/${tent}`);
});

test("the home screen counts unresolved reports and links to them", async () => {
  navigate("/");
  render(<Inventory store={store} />);
  expect(screen.queryByRole("button", { name: /Found gear/ })).not.toBeInTheDocument();

  await store.receive([reported("01000000000000000000000001", "by the gate", tent)], 1);
  await user.click(await screen.findByRole("button", { name: "Found gear · 1" }));
  expect(location.pathname).toBe("/found");
});
