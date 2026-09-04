import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { createApi } from "../lib/api";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { SettingsCsv } from "./SettingsCsv";

// Export and import in Settings, Admin only (FR-RPT-03, FR-SET-11). A fake server answers the CSV routes.
const T0 = 1_756_684_800_000;
let store: Store;
let calls: { path: string; body: string }[];
let synced: number;

const shell = {
  busy: false,
  manualBusy: false,
  outcome: null,
  now: () => T0,
  sync: async () => {
    synced += 1;
    return undefined;
  },
  syncNow: async () => undefined,
  signOut: async () => {},
};

const fetchFake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), "http://x").pathname;
  calls.push({ path, body: String(init?.body ?? "") });
  const json = (body: object, status = 200) => new Response(JSON.stringify({ ...body, server_time: T0 }), { status });
  if (path === "/inventory.csv") return new Response("id,kind,name\n,single,Tent\n", { status: 200 });
  if (path === "/inventory/import/preview") {
    const text = String(init?.body ?? "");
    if (text.includes("BAD")) {
      return json({
        adds: 0,
        changes: 0,
        unchanged: 0,
        new_locations: [],
        new_categories: [],
        rows: [],
        errors: [{ row: 2, message: "no such item 'BAD'" }],
      });
    }
    return json({
      adds: 1,
      changes: 1,
      unchanged: 0,
      new_locations: ["Shed"],
      new_categories: [],
      rows: [
        { row: 2, action: "add", name: "Stove", changes: [] },
        { row: 3, action: "change", name: "Tent 1", changes: [{ field: "sub_location", old: "", new: "shelf 4" }] },
      ],
      errors: [],
    });
  }
  if (path === "/inventory/import")
    return json({ added: 1, changed: 1, created_locations: ["Shed"], created_categories: [] });
  return json({ error: "not_found", message: path }, 404);
};

beforeEach(async () => {
  calls = [];
  synced = 0;
  URL.createObjectURL = () => "blob:csv";
  URL.revokeObjectURL = () => {};
  store = await openStore();
});

const user = userEvent.setup();
const mount = () =>
  render(<SettingsCsv store={store} api={createApi({ fetch: fetchFake, token: () => "t" })} shell={shell} />);

test("downloading saves the file in one click", async () => {
  const clicks: { href: string; download: string }[] = [];
  const real = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    clicks.push({ href: this.getAttribute("href") ?? "", download: this.download });
  };
  try {
    mount();
    await user.click(screen.getByRole("button", { name: "Download inventory.csv" }));
    await waitFor(() => expect(clicks).toEqual([{ href: "blob:csv", download: "inventory.csv" }]));
    expect(calls.map((c) => c.path)).toContain("/inventory.csv");
    expect(screen.queryByRole("link", { name: "Download inventory.csv" })).not.toBeInTheDocument();
  } finally {
    HTMLAnchorElement.prototype.click = real;
  }
});

test("choosing a file previews it, and applying writes it", async () => {
  mount();
  const file = new File(["id,kind,name\n,single,Stove\n"], "inventory.csv", { type: "text/csv" });
  await user.upload(screen.getByLabelText("Import a CSV"), file);

  const notice = await screen.findByRole("status");
  const preview = within(notice);
  expect(preview.getByText("1 to add, 1 to change, 0 unchanged.")).toBeInTheDocument();
  expect(preview.getByText("New locations: Shed.")).toBeInTheDocument();
  const changes = within(screen.getByRole("list", { name: "Import changes" }));
  expect(changes.getByText(/Row 3: Tent 1/)).toBeInTheDocument();
  expect(changes.getByText("sub_location: was blank now shelf 4")).toBeInTheDocument();

  const previewCall = calls.find((c) => c.path === "/inventory/import/preview");
  expect(previewCall?.body).toContain("Stove");

  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(await screen.findByText(/Added 1, changed 1\./)).toBeInTheDocument();
  expect(screen.getByText(/Created 1 location\./)).toBeInTheDocument();
  expect(calls.map((c) => c.path)).toContain("/inventory/import");
  expect(synced).toBe(1);
});

test("a plan with an error disables Apply and shows the error", async () => {
  mount();
  const file = new File(["id,kind,name\nBAD,single,Stove\n"], "inventory.csv", { type: "text/csv" });
  await user.upload(screen.getByLabelText("Import a CSV"), file);

  const errors = await screen.findByRole("list", { name: "Import errors" });
  expect(within(errors).getByText("Row 2: no such item 'BAD'")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
});
