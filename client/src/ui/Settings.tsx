import { useState } from "react";
import type { Shell } from "../shell";
import {
  createCategory,
  createLocation,
  deleteCategory,
  deleteLocation,
  renameCategory,
  renameLocation,
  setGroup,
} from "../lib/actions";
import { type Api, ApiError, type AssistantToken, Offline } from "../lib/api";
import { categories, group, locations } from "../lib/inventory";
import { BASE, navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useUnsaved } from "../lib/unsaved";
import { useStore } from "../useStore";
import { CsvTools } from "./CsvTools";
import { DeviceList } from "./Devices";
import { syncLabel } from "./labels";
import { NameList } from "./NameList";
import { Page } from "./Page";
import { PrintCodes } from "./PrintCodes";

interface Props {
  store: Store;
  api: Api;
  shell: Shell;
}

export function Settings({ store, api, shell }: Props) {
  useStore(store);
  const pending = store.pending.length;
  const admin = store.meta.user?.role === "admin";
  // For the devices section below, kept apart from what other sections show.
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    await shell.signOut();
    navigate("/", true);
  }

  return (
    <Page
      title="Settings"
      back="/"
      actions={
        <>
          <button className="primary" type="button" onClick={shell.sync} disabled={shell.busy}>
            Sync now
          </button>
          <button
            type="button"
            onClick={signOut}
            disabled={pending > 0}
            title={pending > 0 ? "Send your unsent records first" : ""}
          >
            Sign out
          </button>
          {pending > 0 && <p className="muted small">Sign out after your unsent records are sent.</p>}
        </>
      }
    >
      <p>Signed in as {store.meta.user?.name ?? "?"}</p>
      <p className="muted">{syncLabel(store.meta.last_sync_at, shell.now(), shell.busy, shell.outcome)}</p>
      {admin && (
        <>
          <nav className="links" aria-label="Admin">
            <button className="link" type="button" onClick={() => navigate("/settings/users")}>
              Users
            </button>
            <button className="link" type="button" onClick={() => navigate("/settings/mail")}>
              Mail
            </button>
          </nav>
          <h2 className="section">Group</h2>
          <GroupForm store={store} />
          <h2 className="section">Locations</h2>
          <p className="muted small">
            Where gear lives when it is not out. Every item has one home, picked from this list.
          </p>
          <NameList
            noun="location"
            items={locations(store.state)}
            onAdd={(name) => createLocation(store, name)}
            onRename={(id, name) => renameLocation(store, id, name)}
            onDelete={(id) => deleteLocation(store, id)}
          />
          <h2 className="section">Categories</h2>
          <p className="muted small">
            How gear is grouped in the list: tents, stoves, tarps. Optional. Gear with none is listed last.
          </p>
          <NameList
            noun="category"
            items={categories(store.state)}
            onAdd={(name) => createCategory(store, name)}
            onRename={(id, name) => renameCategory(store, id, name)}
            onDelete={(id) => deleteCategory(store, id)}
          />
          <h2 className="section">Print a sheet of codes</h2>
          <PrintCodes api={api} onDone={shell.sync} />
          <h2 className="section">Export and import</h2>
          <CsvTools api={api} onDone={shell.sync} />
        </>
      )}
      {store.meta.user && (
        <>
          <h2 className="section">Your devices</h2>
          {/* FR-USR-17 */}
          <p className="muted small">Phones and assistants signed in as you. Revoke one you have lost.</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <DeviceList
            userId={store.meta.user.id}
            me
            myDevice={store.meta.device_id}
            api={api}
            onError={setError}
            label="Your devices"
          />
        </>
      )}
      <h2 className="section">Assistant</h2>
      <ConnectAssistant api={api} />
      {/* The only way in to the guide (NFR-USE-11). */}
      <nav className="links" aria-label="Guide">
        <button className="link" type="button" onClick={() => navigate("/help")}>
          Help
        </button>
      </nav>
      <p className="muted small">
        <a href="https://github.com/varju/10th-richmond-gear-tracker">Source</a>
      </p>
    </Page>
  );
}

function GroupForm({ store }: { store: Store }) {
  // Drafts sit over the current value, so a bootstrap that lands after the
  // page opens fills the fields, and only typing makes them dirty.
  const current = group(store.state);
  const [draft, setDraft] = useState<{ name?: string; code_url?: string; contact?: string; overdue_days?: string }>({});
  const [saved, setSaved] = useState(false);
  const name = draft.name ?? current.name ?? "";
  const codeUrl = draft.code_url ?? current.code_url ?? "";
  const contact = draft.contact ?? current.contact ?? "";
  const currentDays = typeof current.overdue_days === "number" ? String(current.overdue_days) : "";
  const overdueDays = draft.overdue_days ?? currentDays;
  const dirty =
    name !== (current.name ?? "") ||
    codeUrl !== (current.code_url ?? "") ||
    contact !== (current.contact ?? "") ||
    overdueDays.trim() !== currentDays;
  const setName = (v: string) => setDraft((d) => ({ ...d, name: v }));
  const setCodeUrl = (v: string) => setDraft((d) => ({ ...d, code_url: v }));
  const setContact = (v: string) => setDraft((d) => ({ ...d, contact: v }));
  const setOverdueDays = (v: string) => setDraft((d) => ({ ...d, overdue_days: v }));
  useUnsaved(dirty, { save: () => save().then(() => true) });

  async function save() {
    // Blank means never flag (FR-OUT-14).
    const days = Number.parseInt(overdueDays, 10);
    await setGroup(store, { name, code_url: codeUrl, contact, overdue_days: days > 0 ? days : null });
    setDraft({});
    setSaved(true);
  }

  return (
    <>
      <label>
        <span>Group name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </label>
      <label>
        <span>Code URL</span>
        <input
          type="url"
          value={codeUrl}
          onChange={(e) => setCodeUrl(e.target.value)}
          placeholder="https://example.org/g"
          autoComplete="off"
        />
      </label>
      <p className="muted small">
        Printed on every sticker, so it must be a domain the group owns, not this server’s address.
      </p>
      <label>
        <span>How to reach us</span>
        <input value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="off" />
      </label>
      <p className="muted small">
        Shown to anyone who scans a sticker while signed out, beside the item name and the group name. An email address
        or a web page, not a person’s phone number.
      </p>
      <label>
        <span>Flag gear out longer than (days)</span>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          value={overdueDays}
          onChange={(e) => setOverdueDays(e.target.value)}
          placeholder="Never"
          autoComplete="off"
        />
      </label>
      <button className="small" type="button" onClick={save} disabled={!dirty}>
        Save group
      </button>
      {saved && !dirty && <span className="muted small"> Saved</span>}
    </>
  );
}

/**
 * A token for an MCP client, minted by whoever is signed in (FR-MCP-01). Shown
 * once, like an invite link. It is a device session, so it is listed with the
 * person's phones and revoked the same way (FR-MCP-02).
 */
function ConnectAssistant({ api }: { api: Api }) {
  const [made, setMade] = useState<AssistantToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      setMade((await api.connectAssistant()).data);
    } catch (e) {
      if (e instanceof Offline) setError("Needs a connection. Tokens are made on the server.");
      else if (e instanceof ApiError) setError(e.message);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!made) {
    return (
      <>
        <p className="muted small">
          Ask an assistant about the inventory, and let it book gear for you. It can do what you can do in the app, and
          nothing an Admin does.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="button" onClick={connect} disabled={busy}>
          Connect an assistant
        </button>
      </>
    );
  }

  return (
    <div className="notice" role="status">
      <p>
        Paste this token into your assistant. It is shown once.
        <br />
        <code className="wrap">{made.token}</code>
      </p>
      <p className="muted small">
        Server: <code className="wrap">{`${location.origin}${BASE}${made.path}`}</code>
        <br />
        Send it as the header <code>Authorization: Bearer &lt;token&gt;</code>.
      </p>
      <p className="muted small">It is now in your device list above. Revoke it there if it is ever lost.</p>
      <div className="row">
        <button type="button" className="minor primary" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="minor" onClick={() => setMade(null)}>
          Done
        </button>
      </div>
    </div>
  );
}
