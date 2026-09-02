import { useState } from "react";
import type { Shell } from "../shell";
import {
  createLocation,
  createType,
  deleteLocation,
  deleteType,
  renameLocation,
  renameType,
  setGroup,
} from "../lib/actions";
import type { Api } from "../lib/api";
import { group, itemTypes, locations } from "../lib/inventory";
import { navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { syncLabel } from "./labels";
import { NameList } from "./NameList";
import { Page } from "./Page";
import { PrintCodes } from "./PrintCodes";

interface Props {
  store: Store;
  api: Api;
  shell: Shell;
}

export function Settings({ store, shell }: Props) {
  useStore(store);
  const pending = store.pending.length;
  const admin = store.meta.user?.role === "admin";

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
          <h2 className="section">Group</h2>
          <GroupForm store={store} />
          <h2 className="section">Locations</h2>
          <NameList
            noun="location"
            items={locations(store.state)}
            onAdd={(name) => createLocation(store, name)}
            onRename={(id, name) => renameLocation(store, id, name)}
            onDelete={(id) => deleteLocation(store, id)}
          />
          <h2 className="section">Types</h2>
          <NameList
            noun="type"
            items={itemTypes(store.state)}
            onAdd={(name) => createType(store, name)}
            onRename={(id, name) => renameType(store, id, name)}
            onDelete={(id) => deleteType(store, id)}
          />
          <h2 className="section">Print a sheet of codes</h2>
          <PrintCodes store={store} onDone={shell.sync} />
        </>
      )}
    </Page>
  );
}

function GroupForm({ store }: { store: Store }) {
  // Drafts sit over the current value, so a bootstrap that lands after the
  // page opens fills the fields, and only typing makes them dirty.
  const current = group(store.state);
  const [draft, setDraft] = useState<{ name?: string; code_url?: string }>({});
  const [saved, setSaved] = useState(false);
  const name = draft.name ?? current.name ?? "";
  const codeUrl = draft.code_url ?? current.code_url ?? "";
  const dirty = name !== (current.name ?? "") || codeUrl !== (current.code_url ?? "");
  const setName = (v: string) => setDraft((d) => ({ ...d, name: v }));
  const setCodeUrl = (v: string) => setDraft((d) => ({ ...d, code_url: v }));

  async function save() {
    await setGroup(store, { name, code_url: codeUrl });
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
        Printed on every sticker, so it must be a domain the group owns, not this server’s address (FR-TAG-13).
      </p>
      <button className="small" type="button" onClick={save} disabled={!dirty}>
        Save group
      </button>
      {saved && !dirty && <span className="muted small"> Saved</span>}
    </>
  );
}
