import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, test, vi } from "vitest";
import { createApi } from "../lib/api";
import { openDb } from "../lib/db";
import { navigate } from "../lib/router";
import { Store } from "../lib/store";
import { Join } from "./Join";
import { SignIn } from "./SignIn";

const user = userEvent.setup();

/** Signed out, as both screens are. */
const openStore = async () => Store.open(await openDb("keyboard", new IDBFactory()), () => 0);

async function mountSignIn() {
  const calls: string[] = [];
  const api = createApi({
    fetch: async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ error: "unauthorized", message: "no" }), { status: 401 });
    },
    now: () => 0,
  });
  render(<SignIn store={await openStore()} api={api} onSignedIn={() => {}} />);
  return calls;
}

const rect = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { visualViewport?: unknown }).visualViewport;
});

test("Return on the email field moves to the password, and Return there signs in", async () => {
  const calls = await mountSignIn();
  const email = screen.getByLabelText("Email");
  const password = screen.getByLabelText("Password");
  expect(email).toHaveAttribute("enterkeyhint", "next");
  expect(password).toHaveAttribute("enterkeyhint", "go");

  await user.type(email, "bea@example.org{Enter}");
  expect(password).toHaveFocus();
  expect(calls).toEqual([]);

  await user.type(password, "battery staple{Enter}");
  await waitFor(() => expect(calls).toHaveLength(1));
});

test("Return walks a join form field by field, and the last one says go", async () => {
  navigate("/join?link=GOOD");
  render(
    <Join
      store={await openStore()}
      api={createApi({ fetch: async () => new Response("{}"), now: () => 0 })}
      onJoined={() => {}}
    />,
  );
  const [name, email, password, again] = ["Name", "Email", "New password", "Again"].map((l) =>
    screen.getByLabelText(l),
  );
  expect([name, email, password, again].map((f) => f?.getAttribute("enterkeyhint"))).toEqual([
    "next",
    "next",
    "next",
    "go",
  ]);

  await user.type(name!, "Cal{Enter}");
  expect(email).toHaveFocus();
  await user.type(email!, "cal@example.org{Enter}");
  expect(password).toHaveFocus();
  await user.type(password!, "battery staple{Enter}");
  expect(again).toHaveFocus();
});

// A bare click event: iOS moves no focus for a tap on plain background, unlike user-event.
test("a tap on the background closes the keyboard; a tap on a field, label, or link does not", async () => {
  await mountSignIn();
  const password = screen.getByLabelText("Password");
  password.focus();

  fireEvent.click(password);
  fireEvent.click(screen.getByText("Email"));
  const link = screen.getByRole("link", { name: "Privacy" });
  link.addEventListener("click", (e) => e.preventDefault());
  fireEvent.click(link);
  expect(password).toHaveFocus();

  fireEvent.click(screen.getByRole("main"));
  expect(password).not.toHaveFocus();
});

test("focus and a keyboard opening scroll the button up, never past the focused field", async () => {
  const vv = Object.assign(new EventTarget(), { offsetTop: 0, height: 800 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  await mountSignIn();
  const email = screen.getByLabelText("Email");
  vi.spyOn(email, "getBoundingClientRect").mockReturnValue(rect(200, 256));
  const button = vi.spyOn(screen.getByRole("button", { name: "Sign in" }), "getBoundingClientRect");
  button.mockReturnValue(rect(700, 756));

  // Room for everything: no scroll.
  await user.click(email);
  await new Promise(requestAnimationFrame);
  expect(scrollBy).not.toHaveBeenCalled();

  // The keyboard takes the bottom 400px: the button is 356px under it.
  vv.height = 400;
  vv.dispatchEvent(new Event("resize"));
  expect(scrollBy).toHaveBeenLastCalledWith(0, 200);

  // A field lower down leaves room to scroll the whole way.
  vi.spyOn(email, "getBoundingClientRect").mockReturnValue(rect(500, 556));
  vv.dispatchEvent(new Event("resize"));
  expect(scrollBy).toHaveBeenLastCalledWith(0, 356);

  // Nothing focused: nothing moves.
  email.blur();
  scrollBy.mockClear();
  vv.dispatchEvent(new Event("resize"));
  expect(scrollBy).not.toHaveBeenCalled();
});
