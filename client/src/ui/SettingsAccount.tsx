import { useState } from "react";
import { type Api, ApiError, Offline } from "../lib/api";
import { heldBy } from "../lib/reports";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { Page } from "./Page";

interface Props {
  store: Store;
  api: Api;
  /** Clears this device's sign-in, the way signing out does. */
  onDeleted: () => Promise<void>;
}

/**
 * Delete my account (FR-USR-25). It deactivates the account; nothing is erased.
 * Two taps, and it needs the network, like everything about accounts.
 */
export function SettingsAccount({ store, api, onDeleted }: Props) {
  useStore(store);
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = store.meta.user?.id;
  const pending = store.pending.length;
  const out = me ? heldBy(store.state, me) : 0;

  async function remove() {
    if (!asked) {
      setAsked(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!(await askServer())) return;
      try {
        await onDeleted();
      } catch {
        setError("Your account is deleted. This device signs out the next time it syncs.");
      }
    } finally {
      setBusy(false);
    }
  }

  /** True once the account is gone, including when an earlier try already did it and its reply was lost. */
  async function askServer(): Promise<boolean> {
    try {
      await api.deleteMyAccount();
      return true;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.code === "deactivated")) return true;
      if (e instanceof Offline) setError("Deleting your account needs a connection. Try again when you have signal.");
      else if (e instanceof ApiError) setError(e.message);
      else setError("Something went wrong. Try again.");
      return false;
    }
  }

  return (
    <Page title="Delete my account" back="/settings">
      <p>
        This signs you out here, and you cannot sign in again. Your other devices sign out the next time they connect;
        anything they have not sent yet is sent first. Your name stays on the group's records: check-outs, notes,
        tickets and photos. An Admin can restore your access.
      </p>
      {out > 0 && (
        <p className="notice" role="note">
          You still have {out} item{out === 1 ? "" : "s"} out. {out === 1 ? "It stays" : "They stay"} under your name
          until someone checks {out === 1 ? "it" : "them"} in.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {pending > 0 && <p className="muted small">Delete your account after your unsent records are sent.</p>}
      <div className="actions">
        <button
          type="button"
          className={asked ? "warn" : ""}
          disabled={busy || pending > 0}
          onClick={() => void remove()}
        >
          {asked ? "Really delete? You cannot sign in again" : "Delete my account…"}
        </button>
        {asked && (
          <button type="button" disabled={busy} onClick={() => setAsked(false)}>
            Cancel
          </button>
        )}
      </div>
    </Page>
  );
}
