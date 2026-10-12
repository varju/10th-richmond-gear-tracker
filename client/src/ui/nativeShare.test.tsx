import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { createApi, type CreatedJoinLink } from "../lib/api";
import { CsvTools } from "./CsvTools";
import { PrintCodes } from "./PrintCodes";
import { PrintableJoinLink } from "./Users";

// The iPhone app's branches (NFR-DEP-11): files go to the share sheet, print to the app's plugin.
const T0 = 1_756_684_800_000;

afterEach(() => vi.unstubAllGlobals());

const api = createApi({
  now: () => T0,
  fetch: async (input) => {
    const path = new URL(String(input), "http://x").pathname;
    if (path === "/inventory.csv") return new Response("id,kind,name\n", { status: 200 });
    if (path === "/codes/sheets") return new Response(new Blob(["%PDF"], { type: "application/pdf" }), { status: 200 });
    return new Response("{}", { status: 404 });
  },
});

/** A share sheet that refuses the first `refusals` times, then opens. */
function shareSheet(refusals: number) {
  const names: string[] = [];
  let left = refusals;
  const share = vi.fn(async (data: ShareData) => {
    if (left > 0) {
      left -= 1;
      names.push("refused");
      throw new DOMException("too long since the tap", "NotAllowedError");
    }
    names.push(data.files?.[0]?.name ?? "");
  });
  vi.stubGlobal("navigator", { ...navigator, share });
  return { names };
}

test("the app shares the CSV instead of downloading it", async () => {
  const sheet = shareSheet(0);
  render(<CsvTools api={api} onDone={async () => {}} native />);
  await userEvent.click(screen.getByRole("button", { name: "Download inventory.csv" }));
  await waitFor(() => expect(sheet.names).toEqual(["inventory.csv"]));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a refused share sheet for the CSV says so, and a button tries again", async () => {
  const sheet = shareSheet(1);
  render(<CsvTools api={api} onDone={async () => {}} native />);
  await userEvent.click(screen.getByRole("button", { name: "Download inventory.csv" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The share sheet did not open");
  await userEvent.click(screen.getByRole("button", { name: "Share inventory.csv" }));
  await waitFor(() => expect(sheet.names).toEqual(["refused", "inventory.csv"]));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a refused share sheet for the code sheet says so, and a button tries again", async () => {
  const sheet = shareSheet(1);
  const done = vi.fn(async () => {});
  render(<PrintCodes api={api} onDone={done} native />);
  await userEvent.click(screen.getByRole("button", { name: "Print QR codes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The share sheet did not open");
  expect(done).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("button", { name: "Share codes.pdf" }));
  await waitFor(() => expect(sheet.names).toEqual(["refused", "codes.pdf"]));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

const LINK: CreatedJoinLink = {
  id: "l1",
  label: "",
  created_by: "u1",
  created_by_name: "Alex",
  created_at: T0,
  expires_at: null,
  token: "t",
  url: "https://example.org/gear/join?link=t",
  qr_svg: "<svg></svg>",
};

test("the app prints a join link through its plugin", async () => {
  const nativePromise = vi.fn(async () => undefined);
  vi.stubGlobal("Capacitor", { nativePromise });
  render(<PrintableJoinLink group="10th" link={LINK} onDone={() => {}} native />);
  await userEvent.click(screen.getByRole("button", { name: "Print" }));
  expect(nativePromise).toHaveBeenCalledWith("PrintPlugin", "print", {});
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("a print the app cannot do is shown, not dropped", async () => {
  vi.stubGlobal("Capacitor", { nativePromise: async () => Promise.reject(new Error("Printing is not available")) });
  render(<PrintableJoinLink group="10th" link={LINK} onDone={() => {}} native />);
  await userEvent.click(screen.getByRole("button", { name: "Print" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Printing is not available");
});
