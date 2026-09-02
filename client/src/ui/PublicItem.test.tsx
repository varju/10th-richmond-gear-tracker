import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { createApi } from "../lib/api";
import { PublicItem } from "./PublicItem";

const T0 = 1_756_684_800_000;

const answer = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
const tent = { item: { name: "Tent 4" }, group: { name: "10th Richmond", contact: "gear@example.org" } };

function mount(fetchFake: typeof fetch, onSignIn = () => {}) {
  const api = createApi({ fetch: fetchFake, now: () => T0 });
  return render(<PublicItem api={api} code="AAAAAAAAAA" onSignIn={onSignIn} />);
}

/** The page's lookup answers with the tent; anything else goes to `onPost`. */
function withPost(onPost: (init?: RequestInit) => Response | Promise<Response>) {
  const posts: RequestInit[] = [];
  const fetchFake: typeof fetch = async (_input, init) => {
    if (init?.method !== "POST") return answer(tent);
    posts.push(init);
    return onPost(init);
  };
  return { fetchFake, posts };
}

const user = userEvent.setup();

test("a stranger sees the item, the group, and how to reach us (FR-PUB-01)", async () => {
  const calls: string[] = [];
  await mount(async (input) => {
    calls.push(String(input));
    return answer(tent);
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
  // Two buttons: Sign in is for us, Send is the one thing they can do (FR-PUB-05).
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Send", "Sign in"]);
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

test("the finder says where it is, and we say thanks (FR-PUB-02)", async () => {
  const { fetchFake, posts } = withPost(() => answer({}));
  mount(fetchFake);
  await screen.findByText("Tent 4");

  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await user.type(screen.getByLabelText("Where is it?"), "By the gate at Camp Byng");
  await user.type(screen.getByLabelText("How can we reach you? (optional)"), "finder@example.org");
  await user.click(screen.getByRole("button", { name: "Send" }));

  expect(await screen.findByRole("status")).toHaveTextContent("Thanks. We will be in touch.");
  expect(screen.queryByLabelText("Where is it?")).not.toBeInTheDocument();
  expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0]!.body))).toEqual({
    note: "By the gate at Camp Byng",
    contact: "finder@example.org",
    website: "",
  });
  expect(posts[0]!.headers).not.toHaveProperty("Authorization");
});

test("the honeypot is in the form, off screen, and out of the tab order (FR-PUB-04)", async () => {
  const { fetchFake } = withPost(() => answer({}));
  const { container } = mount(fetchFake);
  await screen.findByText("Tent 4");
  const trap = container.querySelector<HTMLInputElement>(".hp input[name=website]")!;
  expect(trap).not.toBeNull();
  expect(trap.tabIndex).toBe(-1);
  expect(trap.closest(".hp")).toHaveAttribute("aria-hidden", "true");
});

test("too many reports, or no signal, is said in words", async () => {
  let offline = false;
  const { fetchFake } = withPost(() => {
    if (offline) throw new TypeError("Failed to fetch");
    return answer({ error: "rate_limited", message: "too many reports; try again later" }, 429);
  });
  mount(fetchFake);
  await screen.findByText("Tent 4");

  await user.type(screen.getByLabelText("Where is it?"), "Here");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("too many reports; try again later");
  // The form stays, with what they typed.
  expect(screen.getByLabelText("Where is it?")).toHaveValue("Here");

  offline = true;
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("No connection. Try again when you have one.");
});
