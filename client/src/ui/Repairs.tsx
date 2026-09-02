import { useState } from "react";
import { DAY_MS } from "../lib/clock";
import { item } from "../lib/inventory";
import { openTickets, type Repair, repairHistory, stateLabel } from "../lib/repairs";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { localDate } from "../lib/time";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { plural } from "./labels";
import { Page } from "./Page";

/** What still needs fixing: every open or in-progress ticket, newest first (FR-REP-05). Then the history (FR-RPT-02). */
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
          <TicketList store={store} tickets={tickets} detail={(r) => `${stateLabel(r.state)} · ${r.description}`} />
        </>
      )}
      <History store={store} />
    </Page>
  );
}

function TicketList({ store, tickets, detail }: { store: Store; tickets: Repair[]; detail: (r: Repair) => string }) {
  return (
    <ul className="items">
      {tickets.map((r) => (
        <li key={r.id}>
          <button className="item" type="button" onClick={() => navigate(`/repairs/${r.id}`)}>
            <span className="item-name">{item(store.state, r.item_id)?.name ?? "(unknown item)"}</span>
            <span className="muted small">{detail(r)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Tickets raised or changed in a date range, last change first (FR-RPT-02). The last 30 days to start. */
function History({ store }: { store: Store }) {
  const { now } = useShell();
  const [from, setFrom] = useState(() => localDate(now() - 30 * DAY_MS));
  const [to, setTo] = useState(() => localDate(now()));
  const rows = repairHistory(store.state, from, to);
  return (
    <section aria-label="History">
      <h2 className="section">History</h2>
      <div className="row">
        <label className="tight">
          <span>From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="tight">
          <span>To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No tickets in that range.</p>
      ) : (
        <TicketList
          store={store}
          tickets={rows}
          detail={(r) =>
            [
              stateLabel(r.state),
              r.added_at !== undefined ? `raised ${localDate(r.added_at)}` : "",
              r.modified_at !== undefined && r.modified_at !== r.added_at ? `changed ${localDate(r.modified_at)}` : "",
            ]
              .filter(Boolean)
              .join(" · ")
          }
        />
      )}
      <p className="muted small">What this phone knows: the last 90 days.</p>
    </section>
  );
}
