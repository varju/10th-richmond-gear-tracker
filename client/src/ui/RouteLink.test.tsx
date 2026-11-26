import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BASE, navigate } from "../lib/router";
import { unsaved } from "../lib/unsaved";
import { RouteLink } from "./RouteLink";

beforeEach(() => navigate("/", true));
afterEach(() => vi.restoreAllMocks());

test("on the website a route is a link, and a plain click stays in the page", async () => {
  render(<RouteLink to="/events?change=1">Events</RouteLink>);
  const link = screen.getByRole("link", { name: "Events" });
  expect(link).toHaveAttribute("href", `${BASE}/events?change=1`);
  await userEvent.setup().click(link);
  expect(location.pathname + location.search).toBe(`${BASE}/events?change=1`);
});

test("a modified click is left to the browser", () => {
  render(<RouteLink to="/events">Events</RouteLink>);
  const link = screen.getByRole("link", { name: "Events" });
  // The test document follows an unhandled link, so stop it after the app has had its say.
  const left: boolean[] = [];
  const watch = (e: Event) => {
    left.push(!e.defaultPrevented);
    e.preventDefault();
  };
  document.addEventListener("click", watch);
  for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) fireEvent.click(link, { [key]: true });
  document.removeEventListener("click", watch);
  expect(left).toEqual([true, true, true, true]);
  expect(location.pathname).toBe(`${BASE}/`);
});

test("a plain click asks before losing a draft", async () => {
  vi.spyOn(unsaved, "any", "get").mockReturnValue(true);
  const ask = vi.spyOn(unsaved, "ask").mockImplementation(() => undefined);
  render(<RouteLink to="/events">Events</RouteLink>);
  await userEvent.setup().click(screen.getByRole("link", { name: "Events" }));
  expect(ask).toHaveBeenCalledOnce();
  expect(location.pathname).toBe(`${BASE}/`);
});

test("in the app it stays a button", async () => {
  render(
    <RouteLink to="/events" native>
      Events
    </RouteLink>,
  );
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Events" }));
  expect(location.pathname).toBe(`${BASE}/events`);
});
