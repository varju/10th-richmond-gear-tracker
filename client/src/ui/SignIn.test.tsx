import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { createApi } from "../lib/api";
import { BASE } from "../lib/router";
import { openStore } from "./codeTestKit";
import { SignIn } from "./SignIn";

test("the sign-in screen links to the privacy policy, under the app's path (FR-PUB-07)", async () => {
  const store = await openStore();
  const api = createApi({ fetch: async () => new Response("{}"), now: () => 0 });
  render(<SignIn store={store} api={api} onSignedIn={() => {}} />);

  const link = screen.getByRole("link", { name: "Privacy" });
  expect(link).toHaveAttribute("href", `${location.origin}${BASE}/privacy`);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener");
});

async function refusedWith(error: string, message: string) {
  const store = await openStore();
  const fetch = async () => new Response(JSON.stringify({ error, message, server_time: 0 }), { status: 429 });
  render(<SignIn store={store} api={createApi({ fetch, now: () => 0 })} onSignedIn={() => {}} />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), "bea@example.org");
  await user.type(screen.getByLabelText("Password"), "wrong guess");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return screen.findByRole("alert");
}

test("a locked email says how long until it may try again (NFR-SEC-16)", async () => {
  expect(await refusedWith("locked", "Too many attempts. Try again in 15 minutes.")).toHaveTextContent(
    "Too many attempts. Try again in 15 minutes.",
  );
});

test("too many attempts from one address says so too (NFR-SEC-18)", async () => {
  expect(
    await refusedWith("rate_limited", "Too many attempts from this network. Try again in 4 minutes."),
  ).toHaveTextContent("Too many attempts from this network. Try again in 4 minutes.");
});
