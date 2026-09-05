import { openConflicts } from "../lib/conflicts";
import { foundReports } from "../lib/found";
import { items } from "../lib/inventory";
import type { State } from "../lib/replay";
import { openTickets } from "../lib/repairs";
import { outCount } from "../lib/reports";
import { upcoming } from "../lib/reservations";
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

/** The read-mostly lists on the Reports page: what is out, what needs fixing, what is coming up. */
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

/** Everywhere the app goes, no counts: shared by the phone's menu and the desk's sidebar. */
function menuLinks(state: State, admin: boolean, empty: boolean, stockCheck: boolean, home: boolean): Link[] {
  return [
    ...(home ? [{ label: "Home", path: "/" }] : []),
    { label: "All items", path: "/items" },
    { label: "Reports", path: "/reports" },
    { label: "Reservations", path: "/reservations" },
    ...(empty ? [] : [{ label: stockCheck ? "Stock check · in progress" : "Stock check", path: "/stock-check" }]),
    ...(admin ? [{ label: "Users", path: "/settings/users" }] : []),
    { label: "Settings", path: "/settings" },
    { label: "Help", path: "/help" },
  ];
}

/**
 * Everywhere else the app goes, so nothing is reachable only by knowing it is
 * there. One list, two layouts: the phone's full-screen menu, and a sidebar
 * beside every desk screen.
 */
export function Sections({ store, layout }: Props) {
  useStore(store);
  const { signOut } = useShell();
  const state = store.state;
  const empty = items(state).length === 0;
  const admin = store.admin;
  const sidebar = layout === "sidebar";
  const pending = store.pending.length;
  // The phone header has a house; the sidebar has no header to put one in.
  const links = menuLinks(state, admin, empty, Boolean(store.meta.stock_check), sidebar);

  const signOutRow = (
    <>
      <button
        className="link"
        type="button"
        onClick={() => void signOut()}
        disabled={pending > 0}
        title={pending > 0 ? "Send your unsent records first" : ""}
      >
        Sign out
      </button>
      {pending > 0 && <p className="muted small">Sign out after your unsent records are sent.</p>}
    </>
  );

  if (!sidebar) {
    return (
      <nav className="links menu" aria-label="Menu">
        <Links links={links} />
        {signOutRow}
      </nav>
    );
  }

  const alerts = alertLinks(state);
  return (
    <nav className="sidebar" aria-label="Sections">
      {alerts.length > 0 && (
        <div className="alerts">
          <Links links={alerts} />
        </div>
      )}
      <Links links={links} />
      {signOutRow}
    </nav>
  );
}
