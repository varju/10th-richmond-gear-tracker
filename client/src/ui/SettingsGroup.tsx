import { useState } from "react";
import { setGroup } from "../lib/actions";
import { group } from "../lib/inventory";
import type { Store } from "../lib/store";
import { useUnsaved } from "../lib/unsaved";
import { useStore } from "../useStore";
import { Page } from "./Page";

interface Props {
  store: Store;
}

/** Group name, address, contact, and the overdue period. Admin only (FR-SET-*). */
export function SettingsGroup({ store }: Props) {
  useStore(store);
  const admin = store.meta.user?.role === "admin";

  if (!admin) {
    return (
      <Page title="Not found" back="/settings">
        <p>Admins only.</p>
      </Page>
    );
  }

  return (
    <Page title="General" back="/settings">
      <GroupForm store={store} />
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
        <span>Site address</span>
        <input
          type="url"
          value={codeUrl}
          onChange={(e) => setCodeUrl(e.target.value)}
          placeholder="https://example.org/gear"
          autoComplete="off"
        />
      </label>
      <p className="muted small">
        Where the app lives. Stickers point at this address plus <code>/g/&lt;code&gt;</code>, so it must be a domain
        the group owns, not this server’s address.
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
