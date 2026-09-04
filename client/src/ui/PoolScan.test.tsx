import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as act from "../lib/actions";
import { item } from "../lib/inventory";
import * as mv from "../lib/movement";
import * as res from "../lib/reservations";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { unsaved } from "../lib/unsaved";
import { openStore, printCodes } from "./codeTestKit";
import { alice, renderInShell, seedUsers } from "./moveTestKit";
import { Scan } from "./Scan";

// Scanning a pool's own code: it may carry one on its container (FR-TAG-15), and
// scanning it opens a count field straight away, instead of the one-tap card (FR-OUT-25).
let store: Store;
let bowls: string;

beforeEach(async () => {
  store = await openStore();
  await seedUsers(store, [alice]);
  await printCodes(store, ["AAAAAAAAAA"]);
  bowls = await act.createPool(store, { name: "Bowls" }, 20);
  await act.bindCode(store, "AAAAAAAAAA", bowls);
});

afterEach(() => unsaved.cancel());

const user = userEvent.setup();

async function typeCode(text: string) {
  const open = screen.queryByRole("button", { name: "Type a code instead" });
  if (open) await user.click(open);
  await user.type(screen.getByLabelText("Code or URL"), text);
  await user.click(screen.getByRole("button", { name: "Go" }));
}

const card = () => screen.getByRole("region", { name: "Bowls" });

test("scanning a pool's code in Check out mode opens straight to the count field (FR-OUT-25)", async () => {
  navigate("/scan?mode=out");
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await waitFor(() => expect(card()).toBeInTheDocument());
  const count = within(card()).getByLabelText("How many");
  expect(count).toHaveValue(1);
  await user.clear(count);
  await user.type(count, "6");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  await waitFor(() => expect(screen.queryByRole("region")).not.toBeInTheDocument());
  expect(item(store.state, bowls)?.pool_out).toEqual({ alice: 6 });
});

test("scanning a pool's code in Return mode opens straight to the count field, prefilled with what is out (FR-OUT-25)", async () => {
  await mv.checkOutPool(store, bowls, { count: 4 });
  navigate("/scan?mode=in");
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await waitFor(() => expect(card()).toBeInTheDocument());
  expect(within(card()).getByLabelText("How many")).toHaveValue(4);
  await user.click(within(card()).getByRole("button", { name: "Return" }));
  await waitFor(() => expect(item(store.state, bowls)?.pool_out).toEqual({}));
});

test("scanning a pool's code with no mode offers Check out, Return, and Recount, like its own page (FR-INV-34)", async () => {
  await mv.checkOutPool(store, bowls, { count: 4 });
  navigate("/scan");
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await waitFor(() => expect(card()).toBeInTheDocument());
  expect(within(card()).getByRole("button", { name: "Check out" })).toBeInTheDocument();
  expect(within(card()).getByRole("button", { name: "Return" })).toBeInTheDocument();
  expect(within(card()).getByRole("button", { name: "Recount" })).toBeInTheDocument();
});

async function packing(generics: { item_id: string; quantity: number }[]) {
  const fall = await res.createReservation(store, {
    event: "Fall Camp",
    starts: "2026-10-02",
    ends: "2026-10-04",
    items: [],
    generics,
  });
  navigate(`/reservations/${fall}`);
  navigate(`/scan?mode=out&reservation=${fall}`);
  renderInShell(<Scan store={store} />);
  await typeCode("AAAAAAAAAA");
  await waitFor(() => expect(card()).toBeInTheDocument());
  const count = within(card()).getByLabelText("How many");
  await user.clear(count);
  await user.type(count, "6");
  await user.click(within(card()).getByRole("button", { name: "Check out" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Bowls" })).not.toBeInTheDocument());
  return fall;
}

test("a count taken while packing a camp that overflows its line raises the line to match (FR-RES-07)", async () => {
  const fall = await packing([{ item_id: bowls, quantity: 4 }]);
  await waitFor(() => expect(res.reservation(store.state, fall)?.generics).toEqual([{ item_id: bowls, quantity: 6 }]));
  expect(item(store.state, bowls)?.pool_out).toEqual({ alice: 6 });
});

test("a pool taken while packing a camp that never listed it joins the list by count (FR-RES-07)", async () => {
  const fall = await packing([]);
  await waitFor(() => expect(res.reservation(store.state, fall)?.generics).toEqual([{ item_id: bowls, quantity: 6 }]));
});
