/**
 * One item's story in a single list, newest first (FR-INV-09): what moved, and
 * what people said about it.
 *
 * Movements and notes used to be two lists, which meant reading both and
 * matching dates by eye. A note made during a check-out belongs to that
 * movement and stays with it; a note made on its own stands as its own entry.
 */
import { aliases, item } from "./inventory";
import { history, type HistoryEntry } from "./movement";
import type { Note } from "./replay";
import type { Store } from "./store";

export type TimelineEntry =
  | { kind: "movement"; id: string; at: number; movement: HistoryEntry }
  | { kind: "note"; id: string; at: number; note: Note };

export function timeline(store: Store, itemId: string): TimelineEntry[] {
  const notes = aliases(store.state, itemId).flatMap((id) => (item(store.state, id)?.notes ?? []) as Note[]);
  const entries: TimelineEntry[] = [
    ...history(store, itemId).map((m) => ({ kind: "movement" as const, id: m.id, at: m.at, movement: m })),
    ...notes.filter((n) => !n.movement_id).map((n) => ({ kind: "note" as const, id: n.id, at: n.at, note: n })),
  ];
  // Same millisecond: the later id wins. Both are ULIDs, so that is the later record.
  return entries.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
}
