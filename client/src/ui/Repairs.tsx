import { useState } from "react";
import { DAY_MS } from "../lib/clock";
import { nameOf } from "../lib/inventory";
import { useTypeRecord } from "../lib/record";
import { openTickets, type Repair, repairHistory, stateLabel } from "../lib/repairs";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { localDate, localMinute } from "../lib/time";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { plural, userName } from "./labels";
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
            <span className="item-name">{nameOf(store.state, r.item_id)}</span>
            <span className="muted small">{detail(r)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Tickets raised or changed in a date range, last change first (FR-RPT-02). The last 30 days to start. */
function History({ store }: { store: Store }) {
  const { now, api } = useShell();
  const [from, setFrom] = useState(() => localDate(now() - 30 * DAY_MS));
  const [to, setTo] = useState(() => localDate(now()));
  // Every ticket the server holds, or this device's copy when there is no signal (FR-INV-31).
  const record = useTypeRecord(store, "repair", api);
  const rows = repairHistory(record ?? store.state, from, to);
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
              r.added_at !== undefined ? raisedLabel(store, r) : "",
              r.modified_at !== undefined && r.modified_at !== r.added_at ? `changed ${localDate(r.modified_at)}` : "",
            ]
              .filter(Boolean)
              .join(" · ")
          }
        />
      )}
      {!record && <p className="muted small">Offline: what this device knows, the last 90 days.</p>}
    </section>
  );
}

/** "Raised by Alice · 2026-09-01 14:32", or "Raised · 2026-09-01 14:32" when the name is not known. */
function raisedLabel(store: Store, r: Repair): string {
  const who = r.raised_by ? userName(store.state, r.raised_by) : "";
  const when = r.added_at !== undefined ? localMinute(r.added_at) : "";
  return [who ? `Raised by ${who}` : "Raised", when].filter(Boolean).join(" · ");
}
