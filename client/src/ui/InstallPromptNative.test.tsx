import { render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { InstallPrompt } from "./InstallPrompt";

// The iPhone app's build, where SERVER_URL is set.
vi.mock("../lib/server", async (actual) => ({ ...(await actual<typeof import("../lib/server")>()), NATIVE: true }));

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile";

afterEach(() => vi.unstubAllGlobals());

test("inside the iPhone app, nothing is offered: not the app, not the home screen", () => {
  vi.stubGlobal("navigator", { ...navigator, userAgent: IPHONE });
  const { container } = render(<InstallPrompt appUrl="https://apps.example.com/app/id1" />);
  expect(container).toBeEmptyDOMElement();
});
