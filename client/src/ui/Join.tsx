import { type FormEvent, useState } from "react";
import { type Api, ApiError, Offline } from "../lib/api";
import { navigate, useRoute } from "../lib/router";
import type { Store } from "../lib/store";

interface Props {
  store: Store;
  api: Api;
  onJoined: () => void;
}

const MIN_PASSWORD = 8;

/**
 * Where an invite or reset link lands: /join?token=… (FR-USR-12). Set a password,
 * and this device is signed in. The link is spent either way.
 *
 * A standing join link lands here too, told apart by `?link=` instead of `?token=` (FR-USR-19):
 * whoever opens it has no account yet, so the form also asks for a name and email, and the link
 * itself is not spent by their joining.
 */
export function Join({ store, api, onJoined }: Props) {
  const query = useRoute().query;
  const token = query.get("token") ?? "";
  const link = query.get("link") ?? "";
  const standing = link !== "";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Why the form is not shown: a link that already worked once (FR-USR-12), which kind decides
  // what the person can do next, or an email that already has an account (FR-USR-19).
  const [blocked, setBlocked] = useState<"invite" | "reset" | "exists" | null>(null);
  const [busy, setBusy] = useState(false);
  const signedIn = store.meta.user;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (password !== again) return setError("The two passwords differ.");
    setBusy(true);
    setError(null);
    setBlocked(null);
    try {
      const { data, offset } = standing
        ? await api.join(link, name.trim(), email.trim(), password, store.meta.device_id)
        : await api.redeem(token, password, store.meta.device_id);
      await store.setMeta({ token: data.token, user: data.user, clock_offset: offset });
      onJoined();
    } catch (e) {
      if (e instanceof Offline) setError("No connection. Joining needs one.");
      else if (e instanceof ApiError && e.code === "invite_used") setBlocked("invite");
      else if (e instanceof ApiError && e.code === "reset_used") setBlocked("reset");
      else if (e instanceof ApiError && e.status === 409) setBlocked("exists");
      else if (e instanceof ApiError) setError(e.message);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="app" onSubmit={submit} noValidate>
      <header>
        <h1>Gear Tracker</h1>
      </header>
      <main>
        {signedIn ? (
          <>
            <p>This device is signed in as {signedIn.name}. Sign out in Settings, then open the link again.</p>
            <button type="button" onClick={() => navigate("/settings")}>
              Settings
            </button>
          </>
        ) : !token && !link ? (
          <p>This link is missing its token. Ask an Admin for a new one.</p>
        ) : blocked === "invite" || blocked === "exists" ? (
          <>
            <p>You already have an account. Sign in instead.</p>
            <button type="button" onClick={() => navigate("/", true)}>
              Sign in
            </button>
          </>
        ) : blocked === "reset" ? (
          <p role="alert">This reset link has already been used. Ask an Admin for a new one.</p>
        ) : (
          <>
            <p>
              {standing ? "Make an account: your name, email, and a password." : "Choose a password for your account."}
            </p>
            {standing && (
              <>
                <label>
                  <span>Name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoComplete="name"
                    autoFocus
                  />
                </label>
                <label>
                  <span>Email</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </label>
              </>
            )}
            <label>
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={MIN_PASSWORD}
              />
            </label>
            <label>
              <span>Again</span>
              <input
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                required
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </main>
      {!signedIn && (token || link) && !blocked && (
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || (standing && (!name.trim() || !email.trim()))}>
            Set password and sign in
          </button>
        </div>
      )}
    </form>
  );
}
