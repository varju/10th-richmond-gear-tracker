/**
 * Upcoming events from the calendar feeds an Admin adds (FR-RES-20), offered as the person
 * types an event name in the reservation form and a scanning session. The list itself lives in
 * `store.meta.calendar_events`, refreshed on every sync (see sync.ts); this is just the search
 * over it, plus the names already used here (FR-RES-27, see movement.ts).
 */
import type { CalendarEvent } from "./api";

/** A row in an event list: a calendar event, or a name used before, which has no dates (FR-RES-27). */
export type EventSuggestion = Pick<CalendarEvent, "summary"> & Partial<Pick<CalendarEvent, "starts" | "ends">>;

/** A name as shown: trimmed, with single spaces. */
export const tidyName = (name: string) => name.trim().replace(/\s+/g, " ");

/** What makes two names the same event: case and spacing aside (FR-RES-26). */
export const eventNameKey = (name: string) => tidyName(name).toLowerCase();

/** Soonest first, one row per event: feeds listing the same name on the same dates are one (FR-RES-26). */
function distinct(events: CalendarEvent[]): CalendarEvent[] {
  const rows = new Map<string, CalendarEvent>();
  for (const e of [...events].sort((a, b) => a.starts.localeCompare(b.starts))) {
    const k = `${eventNameKey(e.summary)}\n${e.starts}\n${e.ends}`;
    if (!rows.has(k)) rows.set(k, e);
  }
  return [...rows.values()];
}

/**
 * Events whose name contains `query`, soonest first, then `used` names that match and no calendar
 * event already offers (FR-RES-27). Empty for a blank query.
 */
export function matchingEvents(
  events: CalendarEvent[] | undefined,
  query: string,
  used: string[] = [],
  limit = 6,
): EventSuggestion[] {
  const q = eventNameKey(query);
  if (!q) return [];
  const calendar = distinct(events ?? []).filter((e) => eventNameKey(e.summary).includes(q));
  const offered = new Set(calendar.map((e) => eventNameKey(e.summary)));
  const names = used
    .filter((n) => eventNameKey(n).includes(q) && !offered.has(eventNameKey(n)))
    .map((summary) => ({ summary }));
  return [...calendar, ...names].slice(0, limit);
}

/** Events running on `day` ("2026-05-01"), soonest first: what a scanning session offers before anything is typed. */
export function eventsOn(events: CalendarEvent[] | undefined, day: string, limit = 6): CalendarEvent[] {
  return distinct((events ?? []).filter((e) => e.starts <= day && day <= e.ends)).slice(0, limit);
}

/** "2026-05-01" for a single day, "2026-05-01 – 2026-05-03" for a range, "Used before" for a name with no dates. */
export function eventDates(e: EventSuggestion): string {
  if (!e.starts || !e.ends) return "Used before";
  return e.starts === e.ends ? e.starts : `${e.starts} – ${e.ends}`;
}
