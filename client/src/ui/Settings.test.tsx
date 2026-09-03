import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { Settings } from "./Settings";

// Settings is a list: who is signed in, the sync line, and a link to each
// section. Sign out lives in the menu, not here.
const T0 = 1_756_684_800_000;
let store: Store;

const shell = {
  busy: false,
  outcome: null,
  now: () => T0,
  sync: async () => undefined,
  signOut: async () => {},
};

beforeEach(async () => {
  store = await openStore();
  navigate("/settings", true);
});

const mount = () => render(<Settings store={store} shell={shell} />);

test("an Admin sees every section, in order", () => {
  mount();
  const links = within(screen.getByRole("navigation", { name: "Settings" })).getAllByRole("button");
  expect(links.map((b) => b.textContent)).toEqual([
    "General",
    "Mail",
    "Locations",
    "Categories",
    "Print QR codes",
    "Export and import",
    "Your devices",
    "Assistant",
  ]);
});

test("a link opens its own page", async () => {
  mount();
  await userEvent.setup().click(screen.getByRole("button", { name: "General" }));
  expect(location.pathname).toBe("/settings/group");
});

test("a User has no admin sections, only their own", async () => {
  await store.setMeta({ user: { id: "bea", name: "Bea", role: "user", active: true } });
  mount();
  const links = within(screen.getByRole("navigation", { name: "Settings" })).getAllByRole("button");
  expect(links.map((b) => b.textContent)).toEqual(["Your devices", "Assistant"]);
});

test("a refused record shows a count above Your devices, and opens the list", async () => {
  const event = await store.record({
    entity_type: "item",
    entity_id: "tent-1",
    type: "note_added",
    actor_id: "alice",
    payload: { text: "hi" },
  });
  await store.pushed([], [{ id: event.id, reason: "not today" }]);
  mount();

  const links = within(screen.getByRole("navigation", { name: "Settings" })).getAllByRole("button");
  const names = links.map((b) => b.textContent);
  expect(names).toContain("1 record the server refused");
  expect(names.indexOf("1 record the server refused")).toBeLessThan(names.indexOf("Your devices"));

  await userEvent.setup().click(screen.getByRole("button", { name: "1 record the server refused" }));
  expect(location.pathname).toBe("/settings/refused");
});

// __GIT_SHA__ is a compile-time constant, baked in by vite.config.ts from the
// GIT_SHA environment variable. Under vitest that variable is unset, so this
// is always "dev" here; the linked-commit rendering is covered by
// `GIT_SHA=... npm run build` in the Makefile task's verification instead.
test("with no build sha, the foot says Source: dev and links nowhere", () => {
  mount();
  const foot = screen.getByText(/^Source:/).closest("p") as HTMLElement;
  expect(foot).toHaveTextContent("Source: dev");
  expect(within(foot).queryAllByRole("link")).toHaveLength(0);
});
