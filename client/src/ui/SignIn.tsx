import { type FormEvent, useState } from "react";
import { type Api, ApiError, Offline } from "../lib/api";
import type { Store } from "../lib/store";

interface Props {
  store: Store;
  api: Api;
  onSignedIn: () => void;
}

export function SignIn({ store, api, onSignedIn }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data, offset } = await api.signIn(email.trim(), password, store.meta.device_id);
      await store.setMeta({ token: data.token, user: data.user, clock_offset: offset });
      onSignedIn();
    } catch (e) {
      if (e instanceof Offline) setError("No connection. Signing in needs one; using the app does not.");
      else if (e instanceof ApiError) setError(e.message);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="app" onSubmit={submit}>
      <header>
        <h1>Gear Tracker</h1>
      </header>
      <main>
        <label>
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </main>
      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>
          Sign in
        </button>
      </div>
    </form>
  );
}
