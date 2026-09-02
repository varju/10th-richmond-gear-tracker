import { type FoundReport, foundReports, resolveFound } from "../lib/found";
import { item } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { isoDate } from "../lib/time";
import { useStore } from "../useStore";
import { Contact } from "./Contact";
import { Page } from "./Page";

/** What strangers have told us, until someone marks each one dealt with (FR-PUB-03). */
export function Found({ store }: { store: Store }) {
  useStore(store);
  const reports = foundReports(store.state);
  return (
    <Page title="Found gear" back="/">
      {reports.length === 0 ? (
        <p>No found reports.</p>
      ) : (
        reports.map((r) => <ReportBlock key={r.id} store={store} report={r} />)
      )}
    </Page>
  );
}

function ReportBlock({ store, report }: { store: Store; report: FoundReport }) {
  const it = report.item_id ? item(store.state, report.item_id) : undefined;
  const name = it?.name ?? report.code;
  return (
    <section className="found" aria-label={name}>
      <button
        className="link"
        type="button"
        onClick={() => navigate(report.item_id ? `/items/${report.item_id}` : `/g/${report.code}`)}
      >
        {name}
      </button>
      <p className="prose">{report.note}</p>
      {report.contact && (
        <p>
          <Contact contact={report.contact} />
        </p>
      )}
      <p className="muted small">Reported {report.added_at ? isoDate(report.added_at) : "—"}</p>
      <button type="button" className="minor" onClick={() => resolveFound(store, report.id)}>
        Resolve
      </button>
    </section>
  );
}
