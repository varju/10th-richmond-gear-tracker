/**
 * Found reports: what a stranger said about our gear, written to the log by
 * the server (FR-PUB-02). They arrive with the rest of the log, so the app
 * shows them offline; a member marks one resolved when it has been dealt
 * with (FR-PUB-03).
 */
import type { Fields, State } from "./replay";
import type { Store } from "./store";

export interface FoundReport {
  id: string;
  code: string;
  /** Null when the sticker was not yet on anything. */
  item_id: string | null;
  note: string;
  contact: string;
  resolved?: boolean;
  added_at?: number;
}

const all = (state: State): FoundReport[] =>
  Object.entries(state.found_report ?? {}).map(([id, fields]: [string, Fields]) => ({ id, ...fields }) as FoundReport);

/** What still needs acting on, newest first. */
export const foundReports = (state: State): FoundReport[] =>
  all(state)
    .filter((r) => !r.resolved)
    .sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0) || (a.id < b.id ? 1 : -1));

export const foundFor = (state: State, itemId: string): FoundReport[] =>
  foundReports(state).filter((r) => r.item_id === itemId);

/** Dealt with. The report itself is the finder's words and is not edited. */
export async function resolveFound(store: Store, id: string): Promise<void> {
  const actor = store.meta.user?.id;
  if (!actor) throw new Error("not signed in");
  const before = (store.state.found_report?.[id] ?? {}) as Partial<FoundReport>;
  if (before.resolved) return;
  await store.record({
    entity_type: "found_report",
    entity_id: id,
    type: "field_changed",
    actor_id: actor,
    payload: { field: "resolved", value: true, old: before.resolved ?? null },
  });
}
