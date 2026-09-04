import { displayName, group } from "../lib/inventory";
import { withQuery } from "../lib/listUrl";
import {
  firstDirection,
  orderParams,
  type OutSort,
  outRows,
  readOrder,
  rowKey,
  sortRows,
  whatIsOut,
} from "../lib/reports";
import { navigate, useRoute } from "../lib/router";
import type { Store } from "../lib/store";
import { localDate } from "../lib/time";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { plural } from "./labels";
import { Page } from "./Page";
import { daysLabel } from "./Report";

const COLUMNS: { key: OutSort; label: string }[] = [
  { key: "item", label: "Item" },
  { key: "holder", label: "Holder" },
  { key: "reservation", label: "Reservation" },
  { key: "days", label: "Out" },
];

/**
 * The desk's version of what is out (FR-RPT-01, NFR-USE-10): every row at
 * once, sortable by any column (FR-RPT-12). The phone shows the same rows as
 * a list; this is it laid out for a table and a mouse.
 */
export function OutTable({ store }: { store: Store }) {
  useStore(store);
  const route = useRoute();
  const order = readOrder(route.query);
  const { now } = useShell();
  const state = store.state;
  const report = whatIsOut(state, now());
  const groupName = group(state).name;

  const list = sortRows(state, outRows(report), order);

  // Clicking the column already sorted on turns it around; any other opens the way it reads best.
  function sortBy(sort: OutSort) {
    const up = order.sort === sort ? !order.up : firstDirection(sort);
    navigate(withQuery("/out", orderParams({ sort, up })), true);
  }

  return (
    <Page title="What is out" back="/">
      <p className="muted small">{[groupName, localDate(now())].filter(Boolean).join(" · ")}</p>
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
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={order.sort === c.key ? (order.up ? "ascending" : "descending") : "none"}
                  >
                    <button className="link" type="button" onClick={() => sortBy(c.key)}>
                      {c.label}
                      {order.sort === c.key && (order.up ? " ▲" : " ▼")}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={rowKey(row)}>
                  <td>
                    <button className="link" type="button" onClick={() => navigate(`/items/${row.item.id}`)}>
                      {displayName(state, row.item)}
                    </button>
                    {row.overdue && <span className="badge overdue">Overdue</span>}
                  </td>
                  <td>{row.holderName}</td>
                  <td>{row.event ?? ""}</td>
                  <td>{row.count != null ? `${row.count} out` : daysLabel(row.days)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Page>
  );
}
