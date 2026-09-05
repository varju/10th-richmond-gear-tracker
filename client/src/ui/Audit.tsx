import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, ApiError, type AuditFilter, type ServerEvent, Offline } from "../lib/api";
import { entries, EVENT_TYPES } from "../lib/audit";
import type { Store } from "../lib/store";
import { localMinute } from "../lib/time";
import { useStore } from "../useStore";
import { userName } from "./labels";
import { Page } from "./Page";

interface Props {
  store: Store;
  api: Api;
}

function describe(e: unknown): string {
  if (e instanceof Offline) return "Needs a connection. The whole log lives on the server, not on this device.";
  if (e instanceof ApiError) return e.message;
  throw e;
}

/**
 * Each row once. A page is asked for by offset, so an event that lands between two pages
 * pushes the log down and the next page starts with the row the last one ended on.
 */
function unique(events: ServerEvent[]): ServerEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => !seen.has(e.id) && Boolean(seen.add(e.id)));
}

/** Everyone the log can name, deactivated included: they stay in the audit (FR-USR-06). */
function people(store: Store): { id: string; name: string }[] {
  return Object.keys(store.state.user ?? {})
    .map((id) => ({ id, name: userName(store.state, id) || id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The whole log on one screen, for an Admin (FR-USR-24): what changed, who did
 * it, and when, narrowed by event, person, and a range of days.
 *
 * A device keeps 90 days (NFR-DATA-03), so this is always the server's answer
 * and needs a connection. It comes a page at a time, newest first.
 */
export function Audit({ store, api }: Props) {
  useStore(store);
  const [filter, setFilter] = useState<AuditFilter>({});
  const [events, setEvents] = useState<ServerEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Changing two filters quickly starts two reads. Only the last one asked for may answer.
  const asked = useRef(0);

  const load = useCallback(
    async (from: AuditFilter, offset: number) => {
      const mine = ++asked.current;
      setBusy(true);
      setError(null);
      try {
        const page = (await api.audit({ ...from, offset: offset || undefined })).data;
        if (asked.current !== mine) return;
        setEvents((held) => (offset === 0 ? page.events : [...(held ?? []), ...page.events]));
        setMore(page.more);
      } catch (e) {
        if (asked.current === mine) setError(describe(e));
      } finally {
        if (asked.current === mine) setBusy(false);
      }
    },
    [api],
  );

  const admin = store.admin;
  useEffect(() => {
    if (admin) void load(filter, 0);
  }, [admin, filter, load]);

  if (!admin) {
    return (
      <Page title="Not found" back="/settings">
        <p>Admins only.</p>
      </Page>
    );
  }

  const set = (patch: AuditFilter) => setFilter({ ...filter, ...patch });
  const rows = entries(store.state, unique(events ?? []));

  return (
    <Page title="Audit log" back="/settings">
      <div className="row">
        <label className="tight">
          <span>Event</span>
          <select value={filter.type ?? ""} onChange={(e) => set({ type: e.target.value || undefined })}>
            <option value="">Any</option>
            {EVENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="tight">
          <span>Person</span>
          <select value={filter.actor ?? ""} onChange={(e) => set({ actor: e.target.value || undefined })}>
            <option value="">Anyone</option>
            {people(store).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <label className="tight">
          <span>From</span>
          <input type="date" value={filter.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
        </label>
        <label className="tight">
          <span>To</span>
          <input type="date" value={filter.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} />
        </label>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!error && events !== null && rows.length === 0 && <p className="muted">Nothing matches.</p>}
      {rows.length > 0 && (
        // One line each, the same shape an item page's Changes list uses.
        <ol className="history" aria-label="Audit log">
          {rows.map((r) => (
            <li key={r.id}>
              {[r.what, r.on, userName(store.state, r.actor_id) || r.actor_id, localMinute(r.at)]
                .filter(Boolean)
                .join(" · ")}
            </li>
          ))}
        </ol>
      )}
      {more && (
        // The offset is what the server has sent, repeats included, not what is drawn.
        <button className="small" type="button" onClick={() => void load(filter, events?.length ?? 0)} disabled={busy}>
          Show more
        </button>
      )}
    </Page>
  );
}
