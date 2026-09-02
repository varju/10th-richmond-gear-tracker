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
import { useUnsaved } from "../lib/unsaved";
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
          <h2 className="section">Types</h2>
          <p className="muted small">
            Gear that is interchangeable, like “4-person tent”. A camp can book two of a type instead of two named
            items.
          </p>
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
  const [draft, setDraft] = useState<{
    name?: string;
    code_url?: string;
    contact?: string;
    overdue_days?: string;
  }>({});
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
    await setGroup(store, {
      name,
      code_url: codeUrl,
      contact,
      overdue_days: days > 0 ? days : null,
    });
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
