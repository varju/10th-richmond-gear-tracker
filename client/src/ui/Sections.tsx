import { openConflicts } from "../lib/conflicts";
import { foundReports } from "../lib/found";
import { countItems, items, rows } from "../lib/inventory";
import type { State } from "../lib/replay";
import { openTickets } from "../lib/repairs";
import { outCount } from "../lib/reports";
import { todayIso, upcoming } from "../lib/reservations";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useShell } from "../shell";
import { useStore } from "../useStore";

interface Props {
  store: Store;
  /** "menu" is the phone's full-screen menu; "sidebar" is the desk (NFR-USE-10). */
  layout: "menu" | "sidebar";
}

export interface Link {
  label: string;
  path: string;
}

function Links({ links }: { links: Link[] }) {
  return links.map((l) => (
    <button key={l.path} className="link" type="button" onClick={() => navigate(l.path)}>
      {l.label}
    </button>
  ));
}

function alertLinks(state: State): Link[] {
  const found = foundReports(state).length;
  const clashes = openConflicts(state).length;
  return [
    ...(found > 0 ? [{ label: `Found gear · ${found}`, path: "/found" }] : []),
    ...(clashes > 0 ? [{ label: `Conflicts · ${clashes}`, path: "/conflicts" }] : []),
  ];
}

/** The read-mostly lists: what is out, what needs fixing, what is coming up. Shared by the sidebar and the Reports page. */
export function reportLinks(state: State, today: string): Link[] {
  const out = outCount(state);
  const broken = openTickets(state).length;
  const booked = upcoming(state, today).length;
  return [
    { label: `What is out${out > 0 ? ` · ${out}` : ""}`, path: "/out" },
    { label: `Needs repair${broken > 0 ? ` · ${broken}` : ""}`, path: "/repairs" },
    { label: `Reservations · ${booked} upcoming`, path: "/reservations" },
  ];
}

/** Things wrong, and only when something is wrong. The phone's home puts them above the day's work. */
export function Alerts({ store }: { store: Store }) {
  useStore(store);
  return <Links links={alertLinks(store.state)} />;
}

/**
 * Everywhere else the app goes, so nothing is reachable only by knowing it is
 * there. One component, two layouts: the phone's full-screen menu, a sidebar
 * beside every desk screen.
 */
export function Sections({ store, layout }: Props) {
  useStore(store);
  const { now, signOut } = useShell();
  const state = store.state;
  const empty = items(state).length === 0;
  const admin = store.meta.user?.role === "admin";
  const sidebar = layout === "sidebar";

  if (!sidebar) {
    const links: Link[] = [
      { label: "All items", path: "/items" },
      { label: "Reports", path: "/reports" },
      ...(empty
        ? []
        : [
            { label: store.meta.stock_check ? "Stock check · in progress" : "Stock check", path: "/stock-check" },
            { label: "Browse by location", path: "/locations" },
          ]),
      ...(admin ? [{ label: "Users", path: "/settings/users" }] : []),
      { label: "Settings", path: "/settings" },
      { label: "Help", path: "/help" },
    ];
    return (
      <nav className="links menu" aria-label="Menu">
        <Links links={links} />
        <button className="link" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </nav>
    );
  }

  const links: Link[] = [
    { label: `Inventory · ${countItems(rows(state, {}))}`, path: "/items" },
    ...reportLinks(state, todayIso(now())),
    ...(empty
      ? []
      : [
          { label: "Browse by location", path: "/locations" },
          { label: store.meta.stock_check ? "Stock check · in progress" : "Stock check", path: "/stock-check" },
        ]),
    ...(admin ? [{ label: "Users", path: "/settings/users" }] : []),
    { label: "Settings", path: "/settings" },
  ];

  const alerts = alertLinks(state);
  return (
    <nav className="sidebar" aria-label="Sections">
      {alerts.length > 0 && (
        <div className="alerts">
          <Links links={alerts} />
        </div>
      )}
      <Links links={links} />
      {/* The guide sits at the foot, out of the way of the day's work (NFR-USE-11). */}
      <div className="sidebar-foot">
        <Links links={[{ label: "Help", path: "/help" }]} />
      </div>
    </nav>
  );
}
