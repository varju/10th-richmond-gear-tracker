import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { createApi, isAssistant } from "../lib/api";
import { SettingsAssistant } from "./SettingsAssistant";

// "Connect an assistant" in Settings (FR-MCP-01). A fake server mints the token.
const T0 = 1_756_684_800_000;
let calls: string[];
let refuse: boolean;

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://x").pathname;
  calls.push(`${init?.method ?? "GET"} ${path}`);
  const json = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
  if (path === "/assistant/connect") {
    if (refuse) return json({ error: "deactivated", message: "this account has been deactivated" }, 403);
    return json({ token: "secret-token", device_id: "mcp-01BBBBBBBBBBBBBBBBBBBBBBBB", path: "/mcp" });
  }
  return json({ error: "not_found", message: path }, 404);
};

beforeEach(() => {
  calls = [];
  refuse = false;
});

const user = userEvent.setup();
const mount = () => render(<SettingsAssistant api={createApi({ fetch: fetchFake, token: () => "t" })} />);

test("the token is minted on request and shown once, with where to send it (FR-MCP-01)", async () => {
  mount();
  await user.click(screen.getByRole("button", { name: "Connect an assistant" }));

  expect(calls).toEqual(["POST /assistant/connect"]);
  expect(await screen.findByText("secret-token")).toBeTruthy();
  expect(screen.getByText(/Bearer/)).toBeTruthy();
  expect(screen.getByText(/\/mcp$/)).toBeTruthy();
  expect(screen.getByText(/device list/)).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByText("secret-token")).toBeNull();
  expect(screen.getByRole("button", { name: "Connect an assistant" })).toBeTruthy();
});

test("a refusal from the server is shown and no token appears", async () => {
  refuse = true;
  mount();
  await user.click(screen.getByRole("button", { name: "Connect an assistant" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("this account has been deactivated");
  expect(screen.queryByText("secret-token")).toBeNull();
});

test("a device id from an assistant is told apart from a phone's (FR-MCP-02)", () => {
  expect(isAssistant("mcp-01BBBBBBBBBBBBBBBBBBBBBBBB")).toBe(true);
  expect(isAssistant("phone-a")).toBe(false);
});
