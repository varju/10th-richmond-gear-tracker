// Shared setup for the movement tests: users the server knows, and a shell whose sync can be asserted on.
import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import type { ServerEvent, User } from "../lib/api";
import type { Store } from "../lib/store";
import { type Shell, ShellContext } from "../shell";

const T0 = 1_756_684_800_000;

export const alice: User = {
  id: "alice",
  name: "Alice",
  role: "admin",
  active: true,
};
export const carol: User = {
  id: "carol",
  name: "Carol",
  role: "user",
  active: true,
};

/** Users arrive from the server as entities; that is where holder names come from. */
export async function seedUsers(store: Store, users: User[]): Promise<void> {
  const events = users.map(
    (u, i): ServerEvent => ({
      id: `0200000000000000000000${String(i + 1).padStart(4, "0")}`,
      entity_type: "user",
      entity_id: u.id,
      type: "created",
      actor_id: "server",
      device_id: "server",
      device_seq: 1000 + i,
      occurred_at: T0,
      clock_offset: 0,
      effective_at: T0,
      received_at: T0,
      seq: 1000 + i,
      payload: { name: u.name, role: u.role, active: u.active },
    }),
  );
  await store.receive(events, 1000 + users.length);
}

/** Render inside a shell whose sync is a spy. */
export function renderInShell(node: ReactNode) {
  const sync = vi.fn(async () => {});
  const shell: Shell = {
    busy: false,
    outcome: null,
    now: Date.now,
    sync,
    signOut: async () => {},
  };
  const result = render(<ShellContext value={shell}>{node}</ShellContext>);
  return { ...result, sync };
}
