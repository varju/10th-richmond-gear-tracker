import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type Api, ApiError, type MailSettings, Offline } from "../lib/api";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { Page } from "./Page";

interface Props {
  store: Store;
  api: Api;
}

type Draft = Omit<MailSettings, "has_password"> & { password: string };

const BLANK: Draft = {
  host: "",
  port: 465,
  encryption: "ssl",
  username: "",
  from_address: "",
  password: "",
};

function describe(e: unknown): string {
  if (e instanceof Offline) return "Needs a connection. Mail is set up on the server, not on this phone.";
  if (e instanceof ApiError) return e.message;
  throw e;
}

/**
 * One mailbox the server sends from (FR-USR-15). Optional: with nothing here,
 * invites and reset links are still shown to copy by hand (FR-USR-12).
 *
 * Everything on this page is a server call. The password is write-only, so a
 * blank one means "keep the one you have".
 */
export function Mail({ store, api }: Props) {
  useStore(store);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [held, setHeld] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { mail } = (await api.mail()).data;
      setHeld(mail?.has_password ?? false);
      setDraft(mail ? { ...mail, password: "" } : BLANK);
      setLoaded(true);
    } catch (e) {
      setError(describe(e));
    }
  }, [api]);

  const admin = store.meta.user?.role === "admin";
  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  if (!admin) {
    return (
      <Page title="Not found" back="/settings">
        <p>Admins only.</p>
      </Page>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  async function act(call: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      setSaid(await call());
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      const { mail } = (await api.saveMail(draft)).data;
      setHeld(mail.has_password);
      setDraft({ ...mail, password: "" });
      return "Saved.";
    });
  }

  const ready = draft.host.trim() !== "" && draft.from_address.trim() !== "";

  return (
    <Page title="Mail" back="/settings">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {said && (
        <p className="notice" role="status">
          {said}
        </p>
      )}
      <p className="muted small">
        Optional. Fill this in and the server mails invites and reset links itself; leave it empty and the links are
        shown for you to copy. An ordinary mailbox at your mail provider is enough — most want an app password here
        rather than the one you type in to read mail.
      </p>
      <form onSubmit={save} aria-label="Mail server">
        <label>
          <span>Server</span>
          <input
            value={draft.host}
            onChange={(e) => set({ host: e.target.value })}
            placeholder="smtp.example.org"
            autoComplete="off"
            required
          />
        </label>
        <label>
          <span>Port</span>
          <input
            type="number"
            min={1}
            max={65535}
            inputMode="numeric"
            value={draft.port}
            onChange={(e) => set({ port: Number.parseInt(e.target.value, 10) || 0 })}
            autoComplete="off"
            required
          />
        </label>
        <label>
          <span>Encryption</span>
          <select value={draft.encryption} onChange={(e) => set({ encryption: e.target.value as Draft["encryption"] })}>
            <option value="ssl">SSL, usually port 465</option>
            <option value="starttls">STARTTLS, usually port 587</option>
            <option value="none">None</option>
          </select>
        </label>
        <label>
          <span>Username</span>
          <input
            value={draft.username}
            onChange={(e) => set({ username: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            value={draft.password}
            onChange={(e) => set({ password: e.target.value })}
            placeholder={held ? "Kept" : ""}
            autoComplete="new-password"
          />
        </label>
        <p className="muted small">
          {held
            ? "A password is saved. It cannot be read back; type a new one to replace it."
            : "Leave both blank if the server takes mail without signing in."}
        </p>
        <label>
          <span>Send from</span>
          <input
            type="email"
            value={draft.from_address}
            onChange={(e) => set({ from_address: e.target.value })}
            placeholder="gear@example.org"
            autoComplete="off"
            required
          />
        </label>
        <div className="row">
          <button type="submit" className="primary" disabled={busy || !ready}>
            Save
          </button>
          <button
            type="button"
            disabled={busy || !loaded}
            onClick={() => act(async () => `Test message sent to ${(await api.testMail()).data.sent_to}.`)}
          >
            Send a test
          </button>
        </div>
      </form>
      <p className="muted small">Save first: the test uses what the server has, and goes to your own address.</p>
      <button
        type="button"
        className="minor"
        disabled={busy || !loaded}
        onClick={() =>
          act(async () => {
            await api.clearMail();
            setHeld(false);
            setDraft(BLANK);
            return "Removed. Links are copied by hand again.";
          })
        }
      >
        Remove this account
      </button>
    </Page>
  );
}
