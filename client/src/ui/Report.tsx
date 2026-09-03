import { displayName, group } from "../lib/inventory";
import { type OutItem, whatIsOut } from "../lib/reports";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { isoDate } from "../lib/time";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { plural } from "./labels";
import { Page } from "./Page";

/** "today", "1 day", "40 days". */
export function daysLabel(days: number): string {
  if (days === 0) return "today";
  return plural(days, "day");
}

function detail(store: Store, entry: OutItem): string {
  return [entry.event ?? "", `out ${daysLabel(entry.days)}`].filter(Boolean).join(" · ");
}

/** The first report: what is out, and who has it (FR-RPT-01). Overdue gear is flagged (FR-OUT-14). */
export function Report({ store }: { store: Store }) {
  useStore(store);
  const { now } = useShell();
  const report = whatIsOut(store.state, now());
  const groupName = group(store.state).name;

  return (
    <Page title="What is out" back="/">
      <p className="muted small">{[groupName, isoDate(now())].filter(Boolean).join(" · ")}</p>
      {report.total === 0 ? (
        <p>Nothing is out.</p>
      ) : (
        <>
          <p className="muted small">
            {plural(report.total, "item")} out{report.overdue > 0 && ` · ${report.overdue} overdue`}
          </p>
          {report.holders.map((holder) => (
            <section key={holder.id} aria-label={holder.name}>
              <h2 className="section">{holder.name}</h2>
              <ul className="items">
                {holder.items.map((entry) => (
                  <li key={entry.item.id}>
                    <button className="item" type="button" onClick={() => navigate(`/items/${entry.item.id}`)}>
                      <span>
                        <span className="item-name">{displayName(store.state, entry.item)}</span>
                        {entry.overdue && <span className="badge overdue">Overdue</span>}
                      </span>
                      <span className="muted small">{detail(store, entry)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </Page>
  );
}
