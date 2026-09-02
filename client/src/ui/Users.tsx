import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type AccountUser, type Api, ApiError, type Device, Offline } from "../lib/api";
import { BASE } from "../lib/router";
import type { Store } from "../lib/store";
import { isoDate } from "../lib/time";
import { useStore } from "../useStore";
import { Page } from "./Page";

interface Props {
  store: Store;
  api: Api;
}

/** The page a link opens. Absolute, because it is pasted into a message (FR-USR-12). */
export const joinUrl = (token: string): string => `${location.origin}${BASE}/join?token=${token}`;

function describe(e: unknown): string {
  if (e instanceof Offline) return "Needs a connection. Users are managed on the server, not on this phone.";
  if (e instanceof ApiError) return e.message;
  throw e;
}

/**
 * Who is in the group, for Admins (FR-USR-04). Invite, change a role, deactivate,
 * hand out a reset link, and cut off one lost phone (FR-USR-14). Everything here
 * is a server call: accounts never reach a device.
 */
export function Users({ store, api }: Props) {
  useStore(store);
  const [users, setUsers] = useState<AccountUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);

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
        onInvited={(name, url) => {
          setLink({ name, url });
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
              onLink={(url) => setLink({ name: u.name, url })}
            />
          ))}
        </ul>
      )}
    </Page>
  );
}

/** A one-time URL, shown once, to copy into whatever the group already uses (FR-USR-12). */
function LinkToPass({ link, onDone }: { link: { name: string; url: string }; onDone: () => void }) {
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
        Send this link to {link.name}. It works once, for a week.
        <br />
        <code className="wrap">{link.url}</code>
      </p>
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
  onInvited: (name: string, url: string) => void;
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
      const { data } = await api.invite(name.trim(), email.trim(), role);
      onInvited(name.trim(), joinUrl(data.token));
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
  onLink: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<Device[] | null>(null);
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

  async function loadDevices() {
    setDevices((await api.devices(user.id)).data.devices);
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && devices === null) void act(loadDevices);
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
              onClick={() => act(async () => onLink(joinUrl((await api.resetLink(user.id)).data.token)))}
            >
              Reset link
            </button>
          </div>
          <h3 className="section small">Devices</h3>
          {devices === null ? (
            <p className="muted small">Loading…</p>
          ) : devices.length === 0 ? (
            <p className="muted small">Not signed in anywhere.</p>
          ) : (
            <ul className="names" aria-label={`Devices of ${user.name}`}>
              {devices.map((d) => {
                const mine = me && d.device_id === myDevice;
                return (
                  <li key={d.device_id} className="row">
                    <span className="small">
                      {mine ? "This phone" : "Phone"} · signed in {isoDate(d.created_at)}
                    </span>
                    <button
                      type="button"
                      className="minor"
                      disabled={busy || mine}
                      title={mine ? "Sign out instead" : ""}
                      onClick={() =>
                        act(async () => setDevices((await api.revokeDevice(user.id, d.device_id)).data.devices))
                      }
                    >
                      Revoke
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted small">
            Revoking a phone ends its access the next time it syncs. The person stays; sign them in on a new phone.
          </p>
        </div>
      )}
    </li>
  );
}
