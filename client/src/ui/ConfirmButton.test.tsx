import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ASK_MS, ConfirmButton } from "./ConfirmButton";

afterEach(() => vi.useRealTimers());

function mount(onConfirm: () => unknown, resetKey?: string) {
  return render(
    <main>
      <p>elsewhere</p>
      <ConfirmButton label="Delete…" confirmLabel="Really delete?" onConfirm={onConfirm} resetKey={resetKey} />
    </main>,
  );
}

test("the first tap warns; the second does it (NFR-USE-07)", async () => {
  const done = vi.fn();
  const user = userEvent.setup();
  mount(done);
  await user.click(screen.getByRole("button", { name: "Delete…" }));
  expect(done).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Really delete?" })).toHaveAttribute("class", "warn");
  await user.click(screen.getByRole("button", { name: "Really delete?" }));
  expect(done).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Delete…" })).toBeInTheDocument();
});

test("it turns back when focus leaves", async () => {
  const done = vi.fn();
  const user = userEvent.setup();
  mount(done);
  await user.click(screen.getByRole("button", { name: "Delete…" }));
  await user.click(document.body);
  expect(screen.getByRole("button", { name: "Delete…" })).toBeInTheDocument();
  expect(done).not.toHaveBeenCalled();
});

test("a tap elsewhere on the page turns it back, though no blur fires", async () => {
  const done = vi.fn();
  const user = userEvent.setup();
  mount(done);
  const button = screen.getByRole("button", { name: "Delete…" });
  await user.click(button);
  fireEvent.click(screen.getByText("elsewhere"));
  expect(screen.getByRole("button", { name: "Delete…" })).toBeInTheDocument();
  expect(done).not.toHaveBeenCalled();
});

test("a changed resetKey turns it back", async () => {
  const user = userEvent.setup();
  const view = mount(vi.fn(), "a");
  await user.click(screen.getByRole("button", { name: "Delete…" }));
  view.rerender(
    <main>
      <ConfirmButton label="Delete…" confirmLabel="Really delete?" onConfirm={vi.fn()} resetKey="b" />
    </main>,
  );
  expect(screen.getByRole("button", { name: "Delete…" })).toBeInTheDocument();
});

test("a failure shows beside the button", async () => {
  const user = userEvent.setup();
  mount(() => Promise.reject(new Error("no connection")));
  await user.click(screen.getByRole("button", { name: "Delete…" }));
  await user.click(screen.getByRole("button", { name: "Really delete?" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("no connection");
});

test("it turns back after a few seconds", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  mount(vi.fn());
  await user.click(screen.getByRole("button", { name: "Delete…" }));
  act(() => {
    vi.advanceTimersByTime(ASK_MS + 1);
  });
  expect(screen.getByRole("button", { name: "Delete…" })).toBeInTheDocument();
});

test("the original class stays while asking", async () => {
  const user = userEvent.setup();
  render(
    <main>
      <ConfirmButton label="Delete…" confirmLabel="Really delete?" onConfirm={vi.fn()} className="row" />
    </main>,
  );
  await user.click(screen.getByRole("button", { name: "Delete…" }));
  expect(screen.getByRole("button", { name: "Really delete?" })).toHaveAttribute("class", "row warn");
});
