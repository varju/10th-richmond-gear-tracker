import type { Shell } from "../shell";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { syncLabel } from "./labels";
import { Page } from "./Page";
import { useStore } from "../useStore";

interface Props {
  store: Store;
  shell: Shell;
}

/** Who is signed in, the sync line, and a link to each section. Sign out lives in the menu. */
export function Settings({ store, shell }: Props) {
  useStore(store);
  const admin = store.meta.user?.role === "admin";

  return (
    <Page
      title="Settings"
      back="/"
      actions={
        <button className="primary" type="button" onClick={shell.sync} disabled={shell.busy}>
          Sync now
        </button>
      }
    >
      <p>Signed in as {store.meta.user?.name ?? "?"}</p>
      <p className="muted">{syncLabel(store.meta.last_sync_at, shell.now(), shell.busy, shell.outcome)}</p>
      <nav className="links" aria-label="Settings">
        {admin && (
          <>
            <button className="link" type="button" onClick={() => navigate("/settings/users")}>
              Users
            </button>
            <button className="link" type="button" onClick={() => navigate("/settings/mail")}>
              Mail
            </button>
            <button className="link" type="button" onClick={() => navigate("/settings/group")}>
              Group
            </button>
            <button className="link" type="button" onClick={() => navigate("/settings/locations")}>
              Locations
            </button>
            <button className="link" type="button" onClick={() => navigate("/settings/categories")}>
              Categories
            </button>
            <button className="link" type="button" onClick={() => navigate("/settings/codes")}>
              Print codes
            </button>
            <button className="link" type="button" onClick={() => navigate("/settings/csv")}>
              Export and import
            </button>
          </>
        )}
        <button className="link" type="button" onClick={() => navigate("/settings/devices")}>
          Your devices
        </button>
        <button className="link" type="button" onClick={() => navigate("/settings/assistant")}>
          Assistant
        </button>
      </nav>
      <p className="muted small">
        <a href="https://github.com/varju/10th-richmond-gear-tracker">Source</a>
        {" · "}
        {__GIT_SHA__ === "dev" ? (
          "dev"
        ) : (
          <a href={`https://github.com/varju/10th-richmond-gear-tracker/commit/${__GIT_SHA__}`}>{__GIT_SHA__}</a>
        )}
      </p>
    </Page>
  );
}
