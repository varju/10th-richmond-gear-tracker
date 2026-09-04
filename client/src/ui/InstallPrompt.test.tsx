import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { InstallPrompt } from "./InstallPrompt";

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: coarse && query.includes("coarse"), media: query }));
}

function userAgent(ua: string) {
  vi.stubGlobal("navigator", { ...navigator, userAgent: ua });
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

test("on iOS the storage warning names Safari, and the steps are Share then Add to Home Screen", () => {
  pointer(true);
  userAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari");
  render(<InstallPrompt />);
  expect(screen.getByText(/clears a tab’s storage/)).toHaveTextContent("Safari clears a tab’s storage");
  expect(screen.getByText(/Tap Share, then/)).toBeInTheDocument();
});

test("Chrome on Android with no install prompt yet still gets steps, not just Not now", () => {
  pointer(true);
  userAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36");
  render(<InstallPrompt />);
  expect(screen.getByText(/clears a tab’s storage/)).toHaveTextContent("Your browser clears a tab’s storage");
  expect(screen.getByText(/Open the ⋮ menu/)).toHaveTextContent("Add to Home screen” or “Install app”.");
  expect(screen.queryByText(/Tap Share/)).not.toBeInTheDocument();
});

test("Samsung Internet gets its own menu wording", () => {
  pointer(true);
  userAgent(
    "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 SamsungBrowser/25.0 Chrome/115.0 Mobile Safari/537.36",
  );
  render(<InstallPrompt />);
  expect(screen.getByText(/Open the menu/)).toHaveTextContent("Add page to”, then “Home screen”.");
});

test("an unrecognised handheld browser gets a generic hint", () => {
  pointer(true);
  userAgent("Mozilla/5.0 (Linux; Mobile) SomeOtherBrowser/1.0");
  render(<InstallPrompt />);
  expect(screen.getByText(/Open your browser’s menu/)).toBeInTheDocument();
});
