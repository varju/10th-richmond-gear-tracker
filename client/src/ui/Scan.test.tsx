import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { currentCode } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { setVisibility } from "../lib/visibilityTestKit";
import { openStore, printCodes } from "./codeTestKit";
import { type FakeCamera, fakeCamera, stopFakeCamera } from "./scanTestKit";
import { Scan } from "./Scan";

let store: Store;
let tent: string;

let camera: FakeCamera;

beforeEach(async () => {
  camera = fakeCamera();
  store = await openStore();
  await printCodes(store, ["AAAAAAAAAA", "BBBBBBBBBB"]);
  tent = await act.createItem(store, { name: "Tent" });
  const stove = await act.createItem(store, { name: "Stove" });
  await act.bindCode(store, "AAAAAAAAAA", stove);
});

afterEach(() => {
  stopFakeCamera();
  // @ts-expect-error test-only cleanup of a browser API stubbed per test
  delete navigator.vibrate;
  // @ts-expect-error test-only cleanup of a browser API stubbed per test
  delete navigator.mediaDevices;
});

test("without a camera the screen says so, with no empty bar of actions", async () => {
  navigate("/scan");
  const { container } = render(<Scan store={store} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("No camera");
  expect(container.querySelector(".actions")).toBeNull();
});

test("a sticker's URL opens its code", async () => {
  navigate("/scan");
  render(<Scan store={store} native />);
  await camera.scan("https://varju.ca/g/bbbbbbbbbb");
  expect(location.pathname).toBe("/g/BBBBBBBBBB");
});

test("something that is not a code is refused", async () => {
  navigate("/scan");
  render(<Scan store={store} native />);
  await camera.scan("hello");
  expect(screen.getByRole("status")).toHaveTextContent("Not a gear code");
  expect(location.pathname).toBe("/scan");
});

test("with ?for= an unassigned code is bound to the item (FR-TAG-04)", async () => {
  navigate(`/scan?for=${tent}`);
  render(<Scan store={store} native />);
  await camera.scan("BBBBBBBBBB");
  await waitFor(() => expect(location.pathname).toBe(`/items/${tent}`));
  expect(currentCode(store.state, tent)?.id).toBe("BBBBBBBBBB");
});

test("with ?for= a code already on another item is refused", async () => {
  navigate(`/scan?for=${tent}`);
  render(<Scan store={store} native />);
  await camera.scan("AAAAAAAAAA");
  expect(await screen.findByRole("status")).toHaveTextContent("That code is already on Stove");
  expect(currentCode(store.state, tent)).toBeUndefined();
  expect(location.pathname).toBe("/scan");
});

test("with ?for= an unknown code is refused", async () => {
  navigate(`/scan?for=${tent}`);
  render(<Scan store={store} native />);
  await camera.scan("ZZZZZZZZZZ");
  expect(await screen.findByRole("status")).toHaveTextContent("Not one of our codes");
  expect(location.pathname).toBe("/scan");
});

test("a code we do not recognise leaves the phone alone", async () => {
  const buzz = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: buzz, configurable: true });
  navigate("/scan");
  render(<Scan store={store} native />);
  await camera.scan("hello");
  expect(buzz).not.toHaveBeenCalled();
});

test("a code we know buzzes the phone", async () => {
  const buzz = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: buzz, configurable: true });
  navigate("/scan");
  render(<Scan store={store} native />);
  await camera.scan("AAAAAAAAAA");
  expect(buzz).toHaveBeenCalledWith(30);
});

test("a code we know flashes the target green over the card, so a read is seen without a buzz", async () => {
  navigate("/scan");
  const { container } = render(<Scan store={store} native />);
  await camera.scan("AAAAAAAAAA");
  expect(container.querySelector(".viewfinder")).toHaveClass("read");
  expect(await screen.findByRole("heading", { name: "Stove" })).toBeInTheDocument(); // the card is up meanwhile
  await waitFor(() => expect(container.querySelector(".viewfinder")).not.toHaveClass("read"));
});

test("without navigator.vibrate (iOS Safari) a scan still works", async () => {
  navigate("/scan");
  render(<Scan store={store} native />);
  await camera.scan("AAAAAAAAAA");
  expect(await screen.findByRole("heading", { name: "Stove" })).toBeInTheDocument();
});

test("the card opening freezes the frame; closing it resumes without reopening the camera (NFR-USE-01)", async () => {
  navigate("/scan");
  render(<Scan store={store} native />);
  await camera.scan("AAAAAAAAAA"); // bound to Stove: opens the move card
  expect(await screen.findByRole("heading", { name: "Stove" })).toBeInTheDocument();
  expect(camera.calls.filter((c) => c === "pause")).toHaveLength(1);

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Skip" }));
  expect(screen.queryByRole("heading", { name: "Stove" })).not.toBeInTheDocument();
  expect(camera.calls.at(-1)).toBe("resume");
  expect(camera.calls.filter((c) => c === "start")).toHaveLength(1); // the camera is opened once, never restarted
});

test("a camera error clears when the camera works again on return to the app", async () => {
  const stream = Object.assign(new MediaStream(), { getTracks: () => [] });
  const getUserMedia = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("x", "NotReadableError"))
    .mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });

  navigate("/scan");
  render(<Scan store={store} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("in use");
  setVisibility("hidden");
  setVisibility("visible");
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(document.querySelector("video")).not.toHaveAttribute("hidden");
});
