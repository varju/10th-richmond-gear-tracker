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
 */
export function Join({ store, api, onJoined }: Props) {
  const token = useRoute().query.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signedIn = store.meta.user;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (password !== again) return setError("The two passwords differ.");
    setBusy(true);
    setError(null);
    try {
      const { data, offset } = await api.redeem(token, password, store.meta.device_id);
      await store.setMeta({ token: data.token, user: data.user, clock_offset: offset });
      onJoined();
    } catch (e) {
      if (e instanceof Offline) setError("No connection. Joining needs one.");
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
        ) : !token ? (
          <p>This link is missing its token. Ask an Admin for a new one.</p>
        ) : (
          <>
            <p>Choose a password for your account.</p>
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
      {!signedIn && token && (
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            Set password and sign in
          </button>
        </div>
      )}
    </form>
  );
}
