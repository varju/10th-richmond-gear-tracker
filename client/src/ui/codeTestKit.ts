// Shared setup for the code screens' tests: a real store, signed in, with codes "from the server".
import { IDBFactory } from "fake-indexeddb";
import type { ServerEvent } from "../lib/api";
import { openDb } from "../lib/db";
import { Store } from "../lib/store";

const T0 = 1_756_684_800_000;

export async function openStore(): Promise<Store> {
  let clock = T0;
  const store = await Store.open(await openDb("codes", new IDBFactory()), () => clock++);
  await store.setMeta({ token: "t", user: { id: "alice", name: "Alice", role: "admin", active: true } });
  return store;
}

/** Codes come from the server when a sheet is printed; devices only ever bind them. */
export async function printCodes(store: Store, codes: string[]): Promise<void> {
  const events = codes.map(
    (code, i): ServerEvent => ({
      id: `0100000000000000000000${String(i + 1).padStart(4, "0")}`,
      entity_type: "code",
      entity_id: code,
      type: "created",
      actor_id: "server",
      device_id: "server",
      device_seq: i + 1,
      occurred_at: T0,
      clock_offset: 0,
      effective_at: T0,
      received_at: T0,
      seq: i + 1,
      payload: {},
    }),
  );
  await store.receive(events, codes.length);
}
