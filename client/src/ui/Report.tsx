import { displayName, group } from "../lib/inventory";
import {
  firstDirection,
  orderParams,
  type OutEvent,
  type OutRow,
  type OutSort,
  outRows,
  readOrder,
  readOutEvent,
  rowKey,
  sortRows,
  whatIsOut,
} from "../lib/reports";
import { navigate, useRoute } from "../lib/router";
import { withQuery } from "../lib/listUrl";
import type { Store } from "../lib/store";
import { localDate } from "../lib/time";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { plural } from "./labels";
import { Page } from "./Page";

/** "today", "1 day", "40 days". */
export function daysLabel(days: number): string {
  if (days === 0) return "today";
  return plural(days, "day");
}

/** The muted detail line under an item's name. `withHolder` carries the holder's name too, for the
 * flat (non-grouped) sorts, which have no per-holder heading to say whose it is. */
function detail(row: OutRow, withHolder: boolean): string {
  const rest =
    row.count != null
      ? [row.event ?? "", `${row.count} out`].filter(Boolean).join(" · ")
      : [row.event ?? "", `out ${daysLabel(row.days)}`].filter(Boolean).join(" · ");
  return withHolder ? [row.holderName, rest].join(" · ") : rest;
}

function OutRowItem({ store, row, withHolder }: { store: Store; row: OutRow; withHolder: boolean }) {
  return (
    <li>
      <button className="item" type="button" onClick={() => navigate(`/items/${row.item.id}`)}>
        <span>
          <span className="item-name">{displayName(store.state, row.item)}</span>
          {row.overdue && <span className="badge overdue">Overdue</span>}
        </span>
        <span className="muted small">{detail(row, withHolder)}</span>
      </button>
    </li>
  );
}

export function EventFilter({
  events,
  value,
  onChange,
}: {
  events: OutEvent[];
  value: string;
  onChange: (event: string) => void;
}) {
  if (events.length === 0) return null;
  return (
    <label className="tight">
      <span>Event</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All events</option>
        {events.map((e) => (
          <option key={e.key} value={e.key}>
            {e.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The first report: what is out, and who has it (FR-RPT-01). Overdue gear is flagged (FR-OUT-14).
 * Sortable by holder, item, time out, or reservation (FR-RPT-12). */
export function Report({ store }: { store: Store }) {
  useStore(store);
  const { now } = useShell();
  const route = useRoute();
  const { sort, up } = readOrder(route.query);
  const { report, events, event, eventName } = readOutEvent(whatIsOut(store.state, now()), route.query);
  const groupName = group(store.state).name;

  // The select picks a column, not a direction; each one opens the way it reads best. A `dir` the
  // desk's table put in the URL is still honoured, so the same link reads the same on either screen.
  const setSort = (next: OutSort) => {
    navigate(withQuery("/out", orderParams({ sort: next, up: firstDirection(next) }, event)), true);
  };
  const setEvent = (next: string) => {
    navigate(withQuery("/out", orderParams({ sort, up }, next)), true);
  };

  return (
    <Page title="What is out" back="/">
      <p className="muted small">{[groupName, eventName, localDate(now())].filter(Boolean).join(" · ")}</p>
      {report.total === 0 ? (
        <p>Nothing is out.</p>
      ) : (
        <>
          <p className="muted small">
            {plural(report.total, "item")} out{report.overdue > 0 && ` · ${report.overdue} overdue`}
          </p>
          <EventFilter events={events} value={event} onChange={setEvent} />
          <label className="tight">
            <span>Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as OutSort)}>
              <option value="holder">Person</option>
              <option value="item">Item</option>
              <option value="days">Time out</option>
              <option value="reservation">Event</option>
            </select>
          </label>
          {sort === "holder" && up ? (
            report.holders.map((holder) => (
              <section key={holder.id} aria-label={holder.name}>
                <h2 className="section">{holder.name}</h2>
                <ul className="items">
                  {holder.items.map((entry) => (
                    <OutRowItem
                      key={rowKey({ ...entry, holderId: holder.id, holderName: holder.name })}
                      store={store}
                      row={{ ...entry, holderId: holder.id, holderName: holder.name }}
                      withHolder={false}
                    />
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <ul className="items">
              {sortRows(store.state, outRows(report), { sort, up }).map((row) => (
                <OutRowItem key={rowKey(row)} store={store} row={row} withHolder />
              ))}
            </ul>
          )}
        </>
      )}
    </Page>
  );
}
