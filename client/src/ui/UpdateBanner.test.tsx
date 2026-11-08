import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { unsaved } from "../lib/unsaved";
import { update } from "../lib/update";
import { UpdateBanner } from "./UpdateBanner";

afterEach(() => {
  unsaved.unregister("draft");
  unsaved.cancel();
  update.reset();
});

test("hidden until a build is waiting; Reload installs it", async () => {
  const install = vi.fn(async () => {});
  render(<UpdateBanner />);
  expect(screen.queryByRole("status")).toBeNull();
  act(() => update.markReady(install));
  expect(screen.getByRole("status")).toHaveTextContent("A new version is ready");
  await userEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(install).toHaveBeenCalledTimes(1);
});

test("with an unsaved draft, Reload asks first", async () => {
  const install = vi.fn(async () => {});
  act(() => update.markReady(install));
  render(<UpdateBanner />);
  unsaved.register("draft", {});
  await userEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(install).not.toHaveBeenCalled();
  expect(unsaved.pending).not.toBeNull();
  act(() => unsaved.proceed());
  expect(install).toHaveBeenCalledTimes(1);
});

test("while a dialog covers the page it shows the text alone", () => {
  act(() => update.markReady(() => {}));
  render(<UpdateBanner linked={false} />);
  expect(screen.getByRole("status")).toHaveTextContent("A new version is ready");
  expect(screen.queryByRole("button")).toBeNull();
});
