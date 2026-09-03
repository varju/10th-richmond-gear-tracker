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
    "Users",
    "Mail",
    "Group",
    "Locations",
    "Categories",
    "Print codes",
    "Export and import",
    "Your devices",
    "Assistant",
  ]);
});

test("a link opens its own page", async () => {
  mount();
  await userEvent.setup().click(screen.getByRole("button", { name: "Group" }));
  expect(location.pathname).toBe("/settings/group");
});

test("a User has no admin sections, only their own", async () => {
  await store.setMeta({ user: { id: "bea", name: "Bea", role: "user", active: true } });
  mount();
  const links = within(screen.getByRole("navigation", { name: "Settings" })).getAllByRole("button");
  expect(links.map((b) => b.textContent)).toEqual(["Your devices", "Assistant"]);
});

test("the Source link points at the repository", () => {
  mount();
  expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute(
    "href",
    "https://github.com/varju/10th-richmond-gear-tracker",
  );
});
