import { item } from "../lib/inventory";
import { openTickets, stateLabel } from "../lib/repairs";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { plural } from "./labels";
import { Page } from "./Page";

/** What still needs fixing: every open or in-progress ticket, newest first (FR-REP-05). */
export function Repairs({ store }: { store: Store }) {
  useStore(store);
  const tickets = openTickets(store.state);
  return (
    <Page title="Needs repair" back="/">
      {tickets.length === 0 ? (
        <p>Nothing needs repair.</p>
      ) : (
        <>
          <p className="muted small">{plural(tickets.length, "ticket")}</p>
          <ul className="items">
            {tickets.map((r) => (
              <li key={r.id}>
                <button className="item" type="button" onClick={() => navigate(`/repairs/${r.id}`)}>
                  <span className="item-name">{item(store.state, r.item_id)?.name ?? "(unknown item)"}</span>
                  <span className="muted small">
                    {stateLabel(r.state)} · {r.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Page>
  );
}
