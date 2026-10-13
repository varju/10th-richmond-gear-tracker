import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { createApi } from "../lib/api";
import { BASE } from "../lib/router";
import { openStore } from "./codeTestKit";
import { SignIn } from "./SignIn";

test("the sign-in screen links to the privacy policy, under the app's path (FR-PUB-07)", async () => {
  const store = await openStore();
  const api = createApi({ fetch: async () => new Response("{}"), now: () => 0 });
  render(<SignIn store={store} api={api} onSignedIn={() => {}} />);

  expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", `${location.origin}${BASE}/privacy`);
});
