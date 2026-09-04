/**
 * Upcoming events from the calendar feeds an Admin adds (FR-RES-20), offered as the person
 * types an event name in the reservation form and a scanning session. The list itself lives in
 * `store.meta.calendar_events`, refreshed on every sync (see sync.ts); this is just the search
 * over it.
 */
import type { CalendarEvent } from "./api";

/** Events whose name contains `query`, soonest first. Empty for a blank query. */
export function matchingEvents(events: CalendarEvent[] | undefined, query: string, limit = 6): CalendarEvent[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return (events ?? [])
    .filter((e) => e.summary.toLowerCase().includes(q))
    .sort((a, b) => a.starts.localeCompare(b.starts))
    .slice(0, limit);
}

/** "2026-05-01" for a single day, "2026-05-01 – 2026-05-03" for a range. */
export function eventDates(e: Pick<CalendarEvent, "starts" | "ends">): string {
  return e.starts === e.ends ? e.starts : `${e.starts} – ${e.ends}`;
}
