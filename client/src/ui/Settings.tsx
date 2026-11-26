import type { Shell } from "../shell";
import { useAppVersion } from "../lib/appVersion";
import type { Store } from "../lib/store";
import { plural, syncLabel } from "./labels";
import { Page } from "./Page";
import { useStore } from "../useStore";
import { PrivacyLink } from "./PrivacyLink";
import { RouteLink } from "./RouteLink";

interface Props {
  store: Store;
  shell: Shell;
}

/** Who is signed in, the sync line, and a link to each section. Sign out lives in the menu. */
export function Settings({ store, shell }: Props) {
  useStore(store);
  const app = useAppVersion();

  return (
    <Page
      title="Settings"
      back="/"
      actions={
        <button className="primary" type="button" onClick={shell.syncNow} disabled={shell.manualBusy}>
          Sync now
        </button>
      }
    >
      <p>Signed in as {store.meta.user?.name ?? "?"}</p>
      <p className="muted">{syncLabel(store.meta.last_sync_at, shell.now(), shell.busy, shell.outcome)}</p>
      <nav className="links" aria-label="Settings">
        {store.admin && (
          <>
            <RouteLink to="/settings/group">General</RouteLink>
            <RouteLink to="/settings/mail">Mail</RouteLink>
            <RouteLink to="/settings/calendars">Calendars</RouteLink>
            <RouteLink to="/settings/locations">Locations</RouteLink>
            <RouteLink to="/settings/categories">Categories</RouteLink>
            <RouteLink to="/settings/codes">Print QR codes</RouteLink>
            <RouteLink to="/settings/csv">Export and import</RouteLink>
            <RouteLink to="/settings/audit">Audit log</RouteLink>
          </>
        )}
        {store.pending.length > 0 && (
          <RouteLink to="/settings/unsent">{plural(store.pending.length, "unsent record")}</RouteLink>
        )}
        {store.rejected.length > 0 && (
          <RouteLink to="/settings/refused">{plural(store.rejected.length, "record")} the server refused</RouteLink>
        )}
        <RouteLink to="/settings/devices">Your devices</RouteLink>
        <RouteLink to="/settings/notifications">Notifications</RouteLink>
        <RouteLink to="/settings/assistant">AI assistant</RouteLink>
        <RouteLink to="/settings/account">Delete my account</RouteLink>
      </nav>
      <PrivacyLink />
      <p className="muted small">
        Source:{" "}
        {__GIT_SHA__ === "dev" ? (
          "dev"
        ) : (
          <a href={`https://github.com/varju/10th-richmond-gear-tracker/commit/${__GIT_SHA__}`}>{__GIT_SHA__}</a>
        )}
      </p>
      {app && (
        <p className="muted small">
          App {app.version} ({app.build})
        </p>
      )}
    </Page>
  );
}
