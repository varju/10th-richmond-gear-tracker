import { useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type NotificationCategories, Offline } from "../lib/api";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { Page } from "./Page";

interface Props {
  store: Store;
  api: Api;
}

const LABELS: [keyof NotificationCategories, string][] = [
  ["found", "Gear reported found"],
  ["repair", "New repair ticket"],
  ["joined", "Someone joined"],
];

function describe(e: unknown): string {
  if (e instanceof Offline) return "Needs a connection. Notification settings live on the server, not this device.";
  if (e instanceof ApiError) return e.message;
  throw e;
}

/**
 * Email a person chooses to get, one box per event (FR-USR-18). Each box saves itself; there is no
 * separate Save button. Sent through the mail account of Settings > Mail (FR-USR-15); with none set
 * up, ticking a box here changes nothing yet, and the page says so.
 */
export function Notifications({ store, api }: Props) {
  useStore(store);
  const [categories, setCategories] = useState<NotificationCategories | null>(null);
  const [mailConfigured, setMailConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const loaded = (await api.notifications()).data;
      setCategories(loaded.categories);
      setMailConfigured(loaded.mail_configured);
    } catch (e) {
      setError(describe(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(key: keyof NotificationCategories, checked: boolean) {
    if (!categories) return;
    const before = categories;
    const next = { ...categories, [key]: checked };
    setCategories(next);
    setBusy(true);
    setError(null);
    try {
      const saved = (await api.saveNotifications(next)).data;
      setCategories(saved.categories);
      setMailConfigured(saved.mail_configured);
    } catch (e) {
      setCategories(before);
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Notifications" back="/settings">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="muted small">
        One email per event, to this account's address. Nothing is sent for a box left unchecked.
      </p>
      {categories && !mailConfigured && (
        <p className="muted small">No mail account is set up yet, so nothing is sent even for a box ticked here.</p>
      )}
      {categories &&
        LABELS.map(([key, label]) => (
          <label className="check" key={key}>
            <input
              type="checkbox"
              checked={categories[key]}
              disabled={busy}
              onChange={(e) => toggle(key, e.target.checked)}
            />
            <span>{label}</span>
          </label>
        ))}
    </Page>
  );
}
