/** Who a transfer can go to, and in what order (FR-OUT-26, FR-OUT-28). Pure: state and events in, a list out. */
import { DAY_MS } from "./clock";
import { activeUsers } from "./inventory";
import type { ReplayEvent, State } from "./replay";

/** How far back "recently transferred to" looks: three months (FR-OUT-28). It matches the log's retention. */
export const RECENT_TRANSFER_MS = 90 * DAY_MS;

/**
 * Active members other than the holder and `me`: those `me` transferred to in the last three
 * months first, most recent first, then everyone else by name. `events` is the device's local log.
 */
export function transferChoices(
  state: State,
  events: Iterable<ReplayEvent>,
  me: string | undefined,
  holder: string | null | undefined,
  now: number,
): { id: string; name: string }[] {
  const last = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "checked_out" || e.actor_id !== me || !e.payload.supersedes) continue;
    if (now - e.effective_at > RECENT_TRANSFER_MS) continue;
    const to = e.payload.holder_id;
    if (typeof to !== "string" || to === me) continue;
    last.set(to, Math.max(last.get(to) ?? 0, e.effective_at));
  }
  return activeUsers(state)
    .filter((u) => u.id !== holder && u.id !== me)
    .sort((a, b) => (last.get(b.id) ?? -1) - (last.get(a.id) ?? -1) || a.name.localeCompare(b.name));
}
