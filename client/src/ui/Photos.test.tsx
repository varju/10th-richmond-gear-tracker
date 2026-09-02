import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as act from "../lib/actions";
import { createApi, type ServerEvent } from "../lib/api";
import { pendingPhotos } from "../lib/photos";
import type { Store } from "../lib/store";
import { openStore } from "./codeTestKit";
import { renderInShell } from "./moveTestKit";
import { Photos } from "./Photos";

// Photos on an item: fetched when online, counted when not, queued when taken (FR-INV-11).
const T0 = 1_756_684_800_000;
let store: Store;
let tent: string;
const user = userEvent.setup();

beforeEach(async () => {
  store = await openStore();
  tent = await act.createItem(store, { name: "Tent 1" });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => `blob:${b.size}` }));
});

afterEach(() => vi.unstubAllGlobals());

const on = () => ({ entity_type: "item", entity_id: tent });

async function serverHas(...ids: string[]) {
  const events = ids.map(
    (photo_id, i): ServerEvent => ({
      id: `0100000000000000000000${String(i + 1).padStart(4, "0")}`,
      entity_type: "item",
      entity_id: tent,
      type: "photo_added",
      actor_id: "alice",
      device_id: "server",
      device_seq: i + 1,
      occurred_at: T0,
      clock_offset: 0,
      effective_at: T0 + i,
      received_at: T0,
      seq: i + 1,
      payload: { photo_id, content_type: "image/jpeg", size: 10 + i },
    }),
  );
  await store.receive(events, ids.length);
}

const online = createApi({
  fetch: async (input) => new Response(new Blob([String(input)], { type: "image/jpeg" }), { status: 200 }),
  token: () => "t",
});
const offline = createApi({
  fetch: async () => {
    throw new TypeError("Failed to fetch");
  },
  token: () => "t",
});

test("with a connection the photos are fetched and shown; one can be removed", async () => {
  await serverHas("01000000000000000000000AAA", "01000000000000000000000BBB");
  renderInShell(<Photos store={store} on={on()} />, Date.now, online);
  const thumbs = await screen.findAllByRole("button", { name: "View photo" });
  expect(thumbs).toHaveLength(2);

  await user.click(thumbs[0]!);
  expect(screen.getByRole("dialog", { name: "Photo" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Remove" }));
  await user.click(screen.getByRole("button", { name: "Really remove?" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(store.pending.at(-1)).toMatchObject({
    type: "photo_removed",
    payload: { photo_id: "01000000000000000000000AAA" },
  });
  expect(screen.getAllByRole("button", { name: "View photo" })).toHaveLength(1);
});

test("offline, the count is all there is", async () => {
  // Ids this session has not fetched: the strip caches what it has seen.
  await serverHas("01000000000000000000000CCC", "01000000000000000000000DDD");
  renderInShell(<Photos store={store} on={on()} />, Date.now, offline);
  expect(await screen.findByText("2 photos · need a connection to view")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "View photo" })).not.toBeInTheDocument();
});

test("a new photo waits on the device and asks for a sync", async () => {
  const { sync } = renderInShell(<Photos store={store} on={on()} />, Date.now, offline);
  const input = screen.getByLabelText("Photo file") as HTMLInputElement;
  const file = new File(["not really a jpeg"], "tent.jpg", { type: "image/jpeg" });
  fireEvent.change(input, { target: { files: [file] } });

  expect(await screen.findByText("1 photo waiting to upload")).toBeInTheDocument();
  expect((await pendingPhotos(store, on())).length).toBe(1);
  expect(sync).toHaveBeenCalled();
});
