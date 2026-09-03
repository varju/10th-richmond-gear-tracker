import { DAY_MS } from "../lib/clock";
import { openConflicts } from "../lib/conflicts";
import { foundReports } from "../lib/found";
import { displayName } from "../lib/inventory";
import { openTickets } from "../lib/repairs";
import { whatIsOut } from "../lib/reports";
import { todayIso, upcoming } from "../lib/reservations";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { plural } from "./labels";
import { Page } from "./Page";
import { daysLabel } from "./Report";
import { countLabel, datesLabel } from "./Reservations";

/** How far ahead "coming up" looks. A camp further off than this is planning, not packing. */
const AHEAD_DAYS = 28;

interface Row {
  label: string;
  path: string;
}

/**
 * The home screen at a desk (NFR-USE-10). It opens on what needs a person,
 * then answers the question the group cannot answer today (FR-RPT-01), then
 * says what is coming. The phone's home is the locker; this is the paperwork.
 */
export function Desk({ store }: { store: Store }) {
  useStore(store);
  const { now } = useShell();
  const state = store.state;
  const report = whatIsOut(state, now());
  const found = foundReports(state).length;
  const clashes = openConflicts(state).length;
  const broken = openTickets(state).length;
  const unsent = store.pending.length;

  const attention: Row[] = [
    ...(found > 0 ? [{ label: `Found gear · ${found}`, path: "/found" }] : []),
    ...(clashes > 0 ? [{ label: `Conflicts · ${clashes}`, path: "/conflicts" }] : []),
    ...(broken > 0 ? [{ label: `Needs repair · ${broken}`, path: "/repairs" }] : []),
    // Only when the group set a period; without one nothing is overdue (FR-OUT-14).
    ...(report.overdue > 0 ? [{ label: `Overdue · ${report.overdue}`, path: "/out" }] : []),
    ...(store.meta.stock_check ? [{ label: "Stock check in progress", path: "/stock-check" }] : []),
    ...(unsent > 0 ? [{ label: `Unsent records · ${unsent}`, path: "/settings" }] : []),
  ];

  const cutoff = todayIso(now() + AHEAD_DAYS * DAY_MS);
  const soon = upcoming(state, todayIso(now())).filter((r) => r.starts <= cutoff);

  return (
    <Page title="Gear Tracker">
      <h2 className="section">Needs attention</h2>
      {attention.length === 0 ? (
        <p>Nothing needs you.</p>
      ) : (
        <ul className="attention" aria-label="Needs attention">
          {attention.map((row) => (
            <li key={row.path}>
              <button className="link" type="button" onClick={() => navigate(row.path)}>
                {row.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2 className="section">What is out</h2>
      {report.total === 0 ? (
        <p>Nothing is out.</p>
      ) : (
        <>
          <p className="muted small">
            {plural(report.total, "item")} out{report.overdue > 0 && ` · ${report.overdue} overdue`}
          </p>
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Holder</th>
                <th scope="col">Event</th>
                <th scope="col">Out</th>
              </tr>
            </thead>
            <tbody>
              {report.holders.flatMap((holder) =>
                holder.items.map((entry) => (
                  <tr key={entry.item.id}>
                    <td>
                      <button className="link" type="button" onClick={() => navigate(`/items/${entry.item.id}`)}>
                        {displayName(state, entry.item)}
                      </button>
                      {entry.overdue && <span className="badge overdue">Overdue</span>}
                    </td>
                    <td>{holder.name}</td>
                    <td>{entry.event ?? ""}</td>
                    <td>{daysLabel(entry.days)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </>
      )}

      <h2 className="section">Coming up</h2>
      {soon.length === 0 ? (
        <p>Nothing in the next {AHEAD_DAYS} days.</p>
      ) : (
        <ul className="items">
          {soon.map((r) => (
            <li key={r.id}>
              <button className="item" type="button" onClick={() => navigate(`/reservations/${r.id}`)}>
                <span className="item-name">{r.event}</span>
                <span className="muted small">
                  {datesLabel(r)} · {countLabel(r)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
