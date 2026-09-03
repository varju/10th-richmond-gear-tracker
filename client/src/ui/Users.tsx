import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type AccountUser, type Api, ApiError, Offline } from "../lib/api";
import { BASE } from "../lib/router";
import type { Store } from "../lib/store";
import { useStore } from "../useStore";
import { DeviceList } from "./Devices";
import { Page } from "./Page";

interface Props {
  store: Store;
  api: Api;
}

/** The page a link opens. Absolute, because it is pasted into a message (FR-USR-12). */
export const joinUrl = (token: string): string => `${location.origin}${BASE}/join?token=${token}`;

/**
 * The same URL with TOKEN where the token goes. The server fills it in when it
 * mails the link, so it never has to know its own public address (FR-USR-15).
 */
const LINK_TEMPLATE = joinUrl("TOKEN");

function describe(e: unknown): string {
  if (e instanceof Offline) return "Needs a connection. Users are managed on the server, not on this device.";
  if (e instanceof ApiError) return e.message;
  throw e;
}

/**
 * Who is in the group, for Admins (FR-USR-04). Invite, change a role, deactivate,
 * hand out a reset link, and cut off one lost device (FR-USR-14). Everything here
 * is a server call: accounts never reach a device.
 */
export function Users({ store, api }: Props) {
  useStore(store);
  const [users, setUsers] = useState<AccountUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<Passed | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers((await api.users()).data.users);
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

  return (
    <Page title="Users" back="/settings">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {link && <LinkToPass link={link} onDone={() => setLink(null)} />}
      <InviteForm
        api={api}
        onError={setError}
        onInvited={(passed) => {
          setLink(passed);
          void load();
        }}
      />
      {users && (
        <ul className="rows" aria-label="Users">
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              me={store.meta.user?.id === u.id}
              myDevice={store.meta.device_id}
              api={api}
              onChanged={load}
              onError={setError}
              onLink={(passed) => setLink({ ...passed, name: u.name })}
            />
          ))}
        </ul>
      )}
    </Page>
  );
}

/** A one-time link, and what the server did with it. */
interface Passed {
  name: string;
  url: string;
  emailed: boolean;
  mail_error?: string;
}

/** A one-time URL, shown once, to copy into whatever the group already uses (FR-USR-12). */
function LinkToPass({ link, onDone }: { link: Passed; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="notice" role="status">
      <p>
        {link.emailed ? `Emailed to ${link.name}. Send this link as well if it does not arrive.` : null}
        {link.emailed ? null : `Send this link to ${link.name}. It works once, for a week.`}
        <br />
        <code className="wrap">{link.url}</code>
      </p>
      {link.mail_error && <p className="muted small">The mail server would not take it: {link.mail_error}</p>}
      <div className="row">
        <button type="button" className="minor primary" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="minor" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function InviteForm({
  api,
  onInvited,
  onError,
}: {
  api: Api;
  onInvited: (passed: Passed) => void;
  onError: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError(null);
    try {
      const { data } = await api.invite(name.trim(), email.trim(), role, LINK_TEMPLATE);
      onInvited({ ...data, name: name.trim(), url: joinUrl(data.token) });
      setName("");
      setEmail("");
      setRole("user");
      setOpen(false);
    } catch (err) {
      onError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Invite someone
      </button>
    );
  }
  return (
    <form onSubmit={submit} aria-label="Invite">
      <label>
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" autoFocus />
      </label>
      <label>
        <span>Email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
      </label>
      <label>
        <span>Role</span>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !name.trim() || !email.trim()}>
          Invite
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function UserRow({
  user,
  me,
  myDevice,
  api,
  onChanged,
  onError,
  onLink,
}: {
  user: AccountUser;
  me: boolean;
  myDevice: string;
  api: Api;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
  onLink: (passed: Omit<Passed, "name">) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function act(call: () => Promise<unknown>, then?: () => Promise<void> | void) {
    setBusy(true);
    onError(null);
    try {
      await call();
      await then?.();
    } catch (e) {
      onError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    setOpen((o) => !o);
  }

  const status = user.active ? (user.has_password ? "" : "Invited") : "Deactivated";
  const summary = [user.email, user.role === "admin" ? "Admin" : "", status].filter(Boolean).join(" · ");

  return (
    <li>
      <button type="button" className="row" aria-expanded={open} onClick={toggle}>
        <span>
          <span className="item-name">{user.name}</span>
          <br />
          <span className="muted small">{summary}</span>
        </span>
      </button>
      {open && (
        <div className="user-detail">
          <label className="tight">
            <span>Role</span>
            <select
              aria-label={`Role of ${user.name}`}
              value={user.role}
              disabled={busy}
              onChange={(e) => act(() => api.setRole(user.id, e.target.value), onChanged)}
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <div className="row">
            {user.active ? (
              <button
                type="button"
                className="minor"
                disabled={busy || me}
                onClick={() => act(() => api.deactivate(user.id), onChanged)}
              >
                Deactivate
              </button>
            ) : (
              <button
                type="button"
                className="minor"
                disabled={busy}
                onClick={() => act(() => api.reactivate(user.id), onChanged)}
              >
                Reactivate
              </button>
            )}
            <button
              type="button"
              className="minor"
              disabled={busy || !user.active}
              onClick={() =>
                act(async () => {
                  const { data } = await api.resetLink(user.id, LINK_TEMPLATE);
                  onLink({ ...data, url: joinUrl(data.token) });
                })
              }
            >
              Reset link
            </button>
          </div>
          <h3 className="section small">Devices</h3>
          <DeviceList
            userId={user.id}
            me={me}
            myDevice={myDevice}
            api={api}
            onError={onError}
            label={`Devices of ${user.name}`}
          />
          <p className="muted small">The person stays; sign them in on a new device.</p>
        </div>
      )}
    </li>
  );
}
