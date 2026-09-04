import { useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type CalendarFeed, Offline } from "../lib/api";
import type { Store } from "../lib/store";
import { localDate } from "../lib/time";
import { useStore } from "../useStore";
import { Page } from "./Page";

interface Props {
  store: Store;
  api: Api;
}

function describe(e: unknown): string {
  if (e instanceof Offline) return "Needs a connection. Calendar feeds are fetched by the server, not this device.";
  if (e instanceof ApiError) return e.message;
  throw e;
}

/**
 * Calendar feeds an Admin points at the group's own calendar (FR-RES-20). The
 * server fetches and refreshes them; devices only ever see the event names
 * and dates it keeps, through sync, offline.
 *
 * A feed's URL can carry a private token, so it stays on the server, shown
 * here redacted to host and path (NFR-SEC-10).
 */
export function SettingsCalendars({ store, api }: Props) {
  useStore(store);
  const [feeds, setFeeds] = useState<CalendarFeed[] | null>(null);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFeeds((await api.calendars()).data.feeds);
    } catch (e) {
      setError(describe(e));
    }
  }, [api]);

  const admin = store.meta.user?.role === "admin";
  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  if (!admin) {
    return (
      <Page title="Not found" back="/settings">
        <p>Admins only.</p>
      </Page>
    );
  }

  async function act(call: () => Promise<CalendarFeed[]>) {
    setBusy(true);
    setError(null);
    try {
      setFeeds(await call());
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!url.trim()) return;
    await act(async () => {
      await api.addCalendar(url.trim(), label.trim());
      setUrl("");
      setLabel("");
      return (await api.calendars()).data.feeds;
    });
  }

  async function remove(id: string) {
    await act(async () => {
      await api.removeCalendar(id);
      return (await api.calendars()).data.feeds;
    });
  }

  async function refresh() {
    await act(async () => (await api.refreshCalendars()).data.feeds);
  }

  return (
    <Page title="Calendars" back="/settings">
      <p className="muted small">
        Paste the group's calendar feed URLs here. The server checks them hourly and keeps upcoming events, so the
        reservation form and a scanning session can suggest an event name and dates, offline. A feed's own URL never
        leaves the server.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {feeds === null ? (
        <p className="muted small">Loading…</p>
      ) : feeds.length === 0 ? (
        <p className="muted small">No feeds yet.</p>
      ) : (
        <ul className="names">
          {feeds.map((f) => (
            <li key={f.id} className="row">
              <span className="name">
                {f.label || f.url_redacted}
                <br />
                <span className="muted small">
                  {f.label ? f.url_redacted : null}
                  {f.label ? <br /> : null}
                  {f.last_fetched_at ? `Fetched ${localDate(f.last_fetched_at)}` : "Not fetched yet"}
                  {f.last_error ? ` — ${f.last_error}` : ""}
                </span>
              </span>
              <button className="small" type="button" disabled={busy} onClick={() => remove(f.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <button type="button" className="minor" disabled={busy || feeds === null} onClick={refresh}>
          Refresh now
        </button>
      </div>
      <h3 className="section">Add a feed</h3>
      <label>
        <span>Feed URL</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…/basic.ics"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label>
        <span>Label (optional)</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Troop calendar" />
      </label>
      <button type="button" className="primary" disabled={busy || !url.trim()} onClick={add}>
        Add feed
      </button>
    </Page>
  );
}
