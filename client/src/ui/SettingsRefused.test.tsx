import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { SettingsRefused } from "./SettingsRefused";

// What this device tried to record that the server refused (docs/tasks.md, "Sync").
let store: Store;

beforeEach(async () => {
  store = await openStore();
  navigate("/settings/refused", true);
});

const mount = () => render(<SettingsRefused store={store} />);

test("nothing refused says so", () => {
  mount();
  expect(screen.getByText("None.")).toBeInTheDocument();
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

test("a refused record names its type, entity, when, and reason, with a way to discard it", async () => {
  const tent = await act.createItem(store, { name: "Tent 1" });
  const event = await store.record({
    entity_type: "item",
    entity_id: tent,
    type: "field_changed",
    actor_id: "alice",
    payload: { field: "name", value: "Big tent", old: "Tent 1" },
  });
  await store.pushed([], [{ id: event.id, reason: "not today" }]);
  mount();

  const list = screen.getByRole("list", { name: "Refused records" });
  const row = within(list).getByRole("listitem");
  expect(row).toHaveTextContent("field_changed");
  expect(row).toHaveTextContent("Tent 1");
  expect(row).toHaveTextContent("not today");

  await userEvent.setup().click(within(row).getByRole("button", { name: "Discard" }));
  expect(screen.getByText("None.")).toBeInTheDocument();
  expect(store.rejected).toEqual([]);
});
