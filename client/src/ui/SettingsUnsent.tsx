import { entries } from "../lib/audit";
import { localMinute } from "../lib/time";
import type { Shell } from "../shell";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { syncLabel } from "./labels";
import { Page } from "./Page";

/** What this device has not sent yet, and why the last sync did not send it (FR-OFF-15). */
export function SettingsUnsent({ store, shell }: { store: Store; shell: Shell }) {
  useStore(store);
  const pending = store.pending;
  const lines = new Map(entries(store.state, [...pending].reverse()).map((e) => [e.id, e]));

  return (
    <Page
      title="Unsent records"
      back="/settings"
      actions={
        <button className="primary" type="button" onClick={shell.syncNow} disabled={shell.manualBusy}>
          Send now
        </button>
      }
    >
      <p className="muted">{syncLabel(store.meta.last_sync_at, shell.now(), shell.busy, shell.outcome)}</p>
      {pending.length === 0 ? (
        <p className="muted small">Nothing waiting. Everything on this device has been sent.</p>
      ) : (
        <ul className="names" aria-label="Unsent records">
          {pending.map((e) => {
            const line = lines.get(e.id);
            return (
              <li key={e.id} className="row">
                <span className="small">
                  {[line?.what ?? e.type, line?.on, localMinute(e.occurred_at)].filter(Boolean).join(" · ")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
