import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { InstallPrompt } from "./InstallPrompt";

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: coarse && query.includes("coarse"), media: query }));
}

afterEach(() => vi.unstubAllGlobals());

test("a phone is asked to install", () => {
  pointer(true);
  render(<InstallPrompt />);
  expect(screen.getByText(/Add to your home screen/)).toBeInTheDocument();
});

test("a desktop is not: there is no 7-day clearing and no locker", () => {
  pointer(false);
  render(<InstallPrompt />);
  expect(screen.queryByText(/Add to your home screen/)).not.toBeInTheDocument();
});

test("the note says to install first, because the installed app starts empty", () => {
  pointer(true);
  render(<InstallPrompt />);
  expect(screen.getByText(/Do it before you record anything/)).toHaveTextContent("opens signed out and empty");
});
