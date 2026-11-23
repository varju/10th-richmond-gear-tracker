import { typeLabel } from "../lib/audit";
import { displayName, item as itemOf } from "../lib/inventory";
import type { State } from "../lib/replay";
import type { Store, StoredEvent } from "../lib/store";
import { localMinute } from "../lib/time";
import { useStore } from "../useStore";
import { Page } from "./Page";

/** The name of the thing a record was about, or a plain word where the store no longer knows it. */
function entityLabel(state: State, e: StoredEvent): string {
  if (e.entity_type === "item") {
    const it = itemOf(state, e.entity_id);
    return it ? displayName(state, it) : "an item";
  }
  if (e.entity_type === "reservation")
    return (state.reservation?.[e.entity_id]?.event as string | undefined) ?? "an event";
  if (e.entity_type === "repair") return (state.repair?.[e.entity_id]?.description as string | undefined) ?? "a ticket";
  return "a record";
}

/** What this device tried to record that the server would not take (docs/tasks.md, "Sync"). */
export function SettingsRefused({ store }: { store: Store }) {
  useStore(store);
  const refused = store.rejected;

  return (
    <Page title="Refused records" back="/settings">
      <p className="muted small">Made on this device, but the server would not take them. Nothing else was affected.</p>
      {refused.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <ul className="names" aria-label="Refused records">
          {refused.map((e) => (
            <li key={e.id} className="row">
              <span className="small">
                {typeLabel(e.type)} · {entityLabel(store.state, e)} · {localMinute(e.occurred_at)}
                <br />
                {e.reason}
              </span>
              <button type="button" className="minor" onClick={() => void store.discard(e.id)}>
                Discard
              </button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
