import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { InstallPrompt } from "./InstallPrompt";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36";

function userAgent(ua: string) {
  vi.stubGlobal("navigator", { ...navigator, userAgent: ua });
}

afterEach(() => vi.unstubAllGlobals());

test("an iPhone is asked to install: Safari, then Share and Add to Home Screen", () => {
  userAgent(IPHONE);
  render(<InstallPrompt />);
  expect(screen.getByText(/clears a tab’s storage/)).toHaveTextContent("Safari clears a tab’s storage");
  expect(screen.getByText(/Tap Share, then/)).toBeInTheDocument();
});

test("the note says to install first, because the installed app starts empty", () => {
  userAgent(IPHONE);
  render(<InstallPrompt />);
  expect(screen.getByText(/Do it before you record anything/)).toHaveTextContent("opens signed out and empty");
});

test("an iPhone already running from the home screen is not asked", () => {
  userAgent(IPHONE);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("standalone"), media: query }));
  render(<InstallPrompt />);
  expect(screen.queryByText(/Add to your home screen/)).not.toBeInTheDocument();
});

test("Android is not asked: Chrome has no 7-day clearing", () => {
  userAgent(ANDROID);
  render(<InstallPrompt />);
  expect(screen.queryByText(/Add to your home screen/)).not.toBeInTheDocument();
});

test("a desktop is not asked either", () => {
  render(<InstallPrompt />);
  expect(screen.queryByText(/Add to your home screen/)).not.toBeInTheDocument();
});
