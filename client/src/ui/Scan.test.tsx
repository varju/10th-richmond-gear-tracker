import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { currentCode } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { openStore, printCodes } from "./codeTestKit";
import { Scan } from "./Scan";

let store: Store;
let tent: string;

beforeEach(async () => {
  store = await openStore();
  await printCodes(store, ["AAAAAAAAAA", "BBBBBBBBBB"]);
  tent = await act.createItem(store, { name: "Tent" });
  const stove = await act.createItem(store, { name: "Stove" });
  await act.bindCode(store, "AAAAAAAAAA", stove);
});

async function typeCode(text: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Type a code instead" }));
  await user.type(screen.getByLabelText("Code or URL"), text);
  await user.click(screen.getByRole("button", { name: "Go" }));
}

afterEach(() => {
  // @ts-expect-error test-only cleanup of a browser API stubbed per test
  delete navigator.vibrate;
  // @ts-expect-error test-only cleanup of a browser API stubbed per test
  delete navigator.mediaDevices;
});

test("without a camera the screen says so and still takes a typed code", async () => {
  navigate("/scan");
  render(<Scan store={store} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("No camera");
  await typeCode("https://varju.ca/g/bbbbbbbbbb");
  expect(location.pathname).toBe("/g/BBBBBBBBBB");
});

test("something that is not a code is refused", async () => {
  navigate("/scan");
  render(<Scan store={store} />);
  await typeCode("hello");
  expect(screen.getByRole("status")).toHaveTextContent("Not a gear code");
  expect(location.pathname).toBe("/scan");
});

test("with ?for= an unassigned code is bound to the item (FR-TAG-04)", async () => {
  navigate(`/scan?for=${tent}`);
  render(<Scan store={store} />);
  await typeCode("BBBBBBBBBB");
  await waitFor(() => expect(location.pathname).toBe(`/items/${tent}`));
  expect(currentCode(store.state, tent)?.id).toBe("BBBBBBBBBB");
});

test("with ?for= a code already on another item is refused", async () => {
  navigate(`/scan?for=${tent}`);
  render(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  expect(await screen.findByRole("status")).toHaveTextContent("That code is already on Stove");
  expect(currentCode(store.state, tent)).toBeUndefined();
  expect(location.pathname).toBe("/scan");
});

test("with ?for= an unknown code is refused", async () => {
  navigate(`/scan?for=${tent}`);
  render(<Scan store={store} />);
  await typeCode("ZZZZZZZZZZ");
  expect(await screen.findByRole("status")).toHaveTextContent("Not one of our codes");
  expect(location.pathname).toBe("/scan");
});

test("a code we do not recognise leaves the phone alone", async () => {
  const buzz = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: buzz, configurable: true });
  navigate("/scan");
  render(<Scan store={store} />);
  await typeCode("hello");
  expect(buzz).not.toHaveBeenCalled();
});

test("a code we know buzzes the phone", async () => {
  const buzz = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: buzz, configurable: true });
  navigate("/scan");
  render(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  expect(buzz).toHaveBeenCalledWith(30);
});

test("without navigator.vibrate (iOS Safari) a scan still works", async () => {
  navigate("/scan");
  render(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  expect(await screen.findByRole("heading", { name: "Stove" })).toBeInTheDocument();
});

test("the card opening freezes the frame; closing it resumes without reopening the camera (NFR-USE-01)", async () => {
  const stream = Object.assign(new MediaStream(), { getTracks: () => [] });
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });

  navigate("/scan");
  render(<Scan store={store} />);
  const video = document.querySelector("video") as HTMLVideoElement;
  await vi.waitFor(() => expect(video.paused).toBe(false));
  const pauseSpy = vi.spyOn(video, "pause");
  const playSpy = vi.spyOn(video, "play");

  await typeCode("AAAAAAAAAA"); // bound to Stove: opens the move card
  expect(await screen.findByRole("heading", { name: "Stove" })).toBeInTheDocument();
  expect(pauseSpy).toHaveBeenCalledTimes(1);

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Skip" }));
  expect(screen.queryByRole("heading", { name: "Stove" })).not.toBeInTheDocument();
  expect(playSpy).toHaveBeenCalledTimes(1);
  expect(getUserMedia).toHaveBeenCalledTimes(1); // the camera is opened once, never restarted
});
