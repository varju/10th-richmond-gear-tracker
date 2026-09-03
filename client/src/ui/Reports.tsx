import { navigate } from "../lib/router";
import { todayIso } from "../lib/reservations";
import type { Store } from "../lib/store";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { Page } from "./Page";
import { reportLinks } from "./Sections";

/** Where the phone finds the read-mostly lists; the desk keeps them in its sidebar. */
export function Reports({ store }: { store: Store }) {
  useStore(store);
  const { now } = useShell();
  const links = reportLinks(store.state, todayIso(now()));

  return (
    <Page title="Reports" back="/">
      <nav className="links" aria-label="Reports">
        {links.map((l) => (
          <button key={l.path} className="link" type="button" onClick={() => navigate(l.path)}>
            {l.label}
          </button>
        ))}
      </nav>
    </Page>
  );
}
