import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { createApi } from "../lib/api";
import { PublicItem } from "./PublicItem";

const T0 = 1_756_684_800_000;

const answer = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });

function mount(fetchFake: typeof fetch, onSignIn = () => {}) {
  const api = createApi({ fetch: fetchFake, now: () => T0 });
  return render(<PublicItem api={api} code="AAAAAAAAAA" onSignIn={onSignIn} />);
}

test("a stranger sees the item, the group, and how to reach us (FR-PUB-01)", async () => {
  const calls: string[] = [];
  await mount(async (input) => {
    calls.push(String(input));
    return answer({ item: { name: "Tent 4" }, group: { name: "10th Richmond", contact: "gear@example.org" } });
  });

  expect(await screen.findByText("Tent 4")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "10th Richmond" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "gear@example.org" })).toHaveAttribute("href", "mailto:gear@example.org");
  expect(calls).toEqual(["/public/codes/AAAAAAAAAA"]);
});

test("nothing on the page invites them further in", async () => {
  await mount(async () =>
    answer({ item: { name: "Tent 4" }, group: { name: "10th Richmond", contact: "https://example.org/gear" } }),
  );

  await screen.findByText("Tent 4");
  expect(screen.getByRole("link", { name: "https://example.org/gear" })).toHaveAttribute(
    "href",
    "https://example.org/gear",
  );
  // One button, and it is for us, not for them.
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Sign in"]);
});

test("a member who lands here can sign in instead", async () => {
  const onSignIn = vi.fn();
  await mount(
    async () => answer({ item: null, group: { name: "10th Richmond", contact: "gear@example.org" } }),
    onSignIn,
  );

  expect(await screen.findByText("Our gear")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(onSignIn).toHaveBeenCalled();
});

test("a code that is not ours says so", async () => {
  await mount(async () => answer({ error: "not_found", message: "not one of our codes" }, 404));
  expect(await screen.findByRole("alert")).toHaveTextContent("not one of our codes");
});

test("no signal says so, because this page cannot work without one", async () => {
  await mount(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("No connection");
});
