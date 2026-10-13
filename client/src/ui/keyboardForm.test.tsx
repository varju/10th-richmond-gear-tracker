import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, test, vi } from "vitest";
import { createApi } from "../lib/api";
import { openDb } from "../lib/db";
import { navigate } from "../lib/router";
import { Store } from "../lib/store";
import { Join } from "./Join";
import { useKeyboardForm } from "./keyboardForm";
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

// jsdom has no layout and no visual viewport, so the scroll tests supply both. The iPhone's
// keyboard pans the visual viewport without moving the layout; no browser in `make e2e` can show that.
const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, width: 0 }) as DOMRect;
const fakeViewport = (height: number) => {
  const vv = Object.assign(new EventTarget(), { offsetTop: 0, height, scale: 1 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  return vv;
};

async function mountJoin() {
  navigate("/join?link=GOOD");
  render(
    <Join
      store={await openStore()}
      api={createApi({ fetch: async () => new Response("{}"), now: () => 0 })}
      onJoined={() => {}}
    />,
  );
  return ["Name", "Email", "New password", "Again"].map((l) => screen.getByLabelText(l));
}

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
  const [name, email, password, again] = await mountJoin();
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
  const vv = fakeViewport(800);
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

  // A pinch-zoom resizes the visual viewport too: leave the page where the person put it.
  scrollBy.mockClear();
  vv.scale = 2;
  vv.dispatchEvent(new Event("resize"));
  expect(scrollBy).not.toHaveBeenCalled();
  vv.scale = 1;

  // Nothing focused: nothing moves.
  email.blur();
  scrollBy.mockClear();
  vv.dispatchEvent(new Event("resize"));
  expect(scrollBy).not.toHaveBeenCalled();
});

test("an autofocused field gets its button revealed too", async () => {
  fakeViewport(400);
  const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.matches("button") ? rect(700, 756) : rect(200, 256);
  });
  const [name] = await mountJoin();
  expect(name).toHaveFocus();
  await new Promise(requestAnimationFrame);
  expect(scrollBy).toHaveBeenCalledWith(0, 200);
});

test("Go with the button disabled moves to the first empty required field", async () => {
  const [name, email, password, again] = await mountJoin();
  expect(screen.getByRole("button", { name: "Set password and sign in" })).toBeDisabled();
  await user.click(again!);
  await user.keyboard("{Enter}");
  expect(name).toHaveFocus();

  await user.type(name!, "Cal");
  await user.click(again!);
  await user.keyboard("{Enter}");
  expect(email).toHaveFocus();
  expect(password).not.toHaveFocus();
});

test("Return on a button in the form is left to the button", async () => {
  const [name] = await mountJoin();
  const logIn = screen.getByRole("button", { name: "Log in" });
  logIn.focus();
  expect(fireEvent.keyDown(logIn, { key: "Enter" })).toBe(true);
  expect(logIn).toHaveFocus();
  expect(name).not.toHaveFocus();
});

test("the Return that confirms IME input does not move on", async () => {
  await mountSignIn();
  const email = screen.getByLabelText("Email");
  email.focus();
  fireEvent.keyDown(email, { key: "Enter", keyCode: 229 });
  expect(email).toHaveFocus();
});

function Fields() {
  const form = useKeyboardForm();
  return (
    <form ref={form}>
      <input aria-label="A" enterKeyHint="next" />
      <input aria-label="Locked" readOnly />
      <input aria-label="Skipped" tabIndex={-1} />
      <input type="hidden" />
      <input aria-label="B" enterKeyHint="next" />
      <button type="submit">Save</button>
    </form>
  );
}

test("Next skips fields that cannot be typed in, and lets Return through at the end", () => {
  render(<Fields />);
  const a = screen.getByLabelText("A");
  a.focus();
  expect(fireEvent.keyDown(a, { key: "Enter" })).toBe(false);
  const b = screen.getByLabelText("B");
  expect(b).toHaveFocus();
  // Nowhere to go: not swallowed, so Return submits.
  expect(fireEvent.keyDown(b, { key: "Enter" })).toBe(true);
});
