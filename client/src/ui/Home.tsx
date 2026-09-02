import type { Store } from "../lib/store";
import type { SyncOutcome } from "../lib/sync";

interface Props {
  store: Store;
  busy: boolean;
  outcome: SyncOutcome | null;
  now: () => number;
  onSync: () => void;
  onSignOut: () => void;
}

/** The shell. Search, scanning and movement arrive in M6 and M7. */
export function Home({ store, busy, outcome, now, onSync, onSignOut }: Props) {
  const count = Object.keys(store.items).length;
  const pending = store.pending.length;
  return (
    <>
      <header>
        <h1>Gear Tracker</h1>
      </header>
      <main>
        <p className="big">{count}</p>
        <p className="muted">{count === 1 ? "item" : "items"}</p>
        <p className="muted">{synced(store.meta.last_sync_at, now(), busy, outcome)}</p>
        <p className="muted">Signed in as {store.meta.user?.name ?? "?"}</p>
      </main>
      <div className="actions">
        <button className="primary" onClick={onSync} disabled={busy}>
          Sync now
        </button>
        <button onClick={onSignOut} disabled={pending > 0} title={pending > 0 ? "Send your unsent records first" : ""}>
          Sign out
        </button>
      </div>
    </>
  );
}

function synced(at: number | undefined, now: number, busy: boolean, outcome: SyncOutcome | null): string {
  if (busy) return "Syncing…";
  if (outcome?.ok === false && outcome.reason === "offline")
    return at ? `Offline. Last synced ${ago(now - at)}` : "Offline";
  if (outcome?.ok === false) return `Sync failed: ${outcome.message}`;
  return at ? `Synced ${ago(now - at)}` : "Not synced yet";
}

export function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
