import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { InstallPrompt } from "./InstallPrompt";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari";
const APP = "https://apps.example.com/app/id1";
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

test("an iPhone is sent to the group's app when it has one (NFR-DEP-12)", () => {
  userAgent(IPHONE);
  render(<InstallPrompt appUrl={APP} />);
  expect(screen.getByRole("link", { name: "Get it from the App Store" })).toHaveAttribute("href", APP);
  expect(screen.getByText(/Get the iPhone app/).parentElement).toHaveTextContent("The browser clears a tab’s storage");
  expect(screen.getByText(/Sync anything unsent here first/)).toHaveTextContent("sign in to the app");
  expect(screen.queryByText(/Add to your home screen/)).not.toBeInTheDocument();
});

test("the app suggestion has Not now, like the home-screen one", async () => {
  userAgent(IPHONE);
  render(<InstallPrompt appUrl={APP} />);
  await userEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.queryByText(/Get the iPhone app/)).not.toBeInTheDocument();
});

test("an iPad keeps the home-screen hint: the app is for iPhone only", () => {
  userAgent(IPAD);
  render(<InstallPrompt appUrl={APP} />);
  expect(screen.getByText(/Add to your home screen/)).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

test("an iPhone with no app link, or a bad one, keeps the home-screen hint", () => {
  userAgent(IPHONE);
  const { rerender } = render(<InstallPrompt appUrl={null} />);
  expect(screen.getByText(/Add to your home screen/)).toBeInTheDocument();
  for (const bad of ["javascript:alert(1)", "https:apps.example.com/x", "https:/apps.example.com/x"]) {
    rerender(<InstallPrompt appUrl={bad} />);
    expect(screen.getByText(/Add to your home screen/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  }
});

test("the link's scheme may be in capitals, as the server allows", () => {
  userAgent(IPHONE);
  render(<InstallPrompt appUrl="HTTPS://apps.example.com/app/id1" />);
  expect(screen.getByRole("link", { name: "Get it from the App Store" })).toBeInTheDocument();
});

test("an iPhone running from the home screen is offered the app, for its scanner, not its storage", () => {
  userAgent(IPHONE);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("standalone"), media: query }));
  render(<InstallPrompt appUrl={APP} />);
  expect(screen.getByRole("link", { name: "Get it from the App Store" })).toHaveAttribute("href", APP);
  expect(screen.getByText(/Get the iPhone app/).parentElement).toHaveTextContent("Its scanner uses the phone’s camera");
  expect(screen.queryByText(/clears a tab’s storage/)).not.toBeInTheDocument();
  expect(screen.getByText(/Sync anything unsent here first/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
});

test("a Not now given to the home-screen hint does not hide the app's link", () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
  });
  userAgent(IPHONE);
  const { unmount } = render(<InstallPrompt />);
  screen.getByRole("button", { name: "Not now" }).click();
  expect(stored.get("install-snoozed-until")).toBeDefined();
  unmount();

  // The group adds its app later; the next visit home shows it.
  render(<InstallPrompt appUrl={APP} />);
  expect(screen.getByRole("link", { name: "Get it from the App Store" })).toBeInTheDocument();
});
