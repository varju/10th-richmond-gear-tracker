import { type FormEvent, useState } from "react";
import { type Api, ApiError, Offline } from "../lib/api";
import type { Store } from "../lib/store";
import { useKeyboardForm } from "./keyboardForm";
import { PrivacyLink } from "./PrivacyLink";

interface Props {
  store: Store;
  api: Api;
  onSignedIn: () => void;
  /** A word from whatever signed this device out, such as deleting the account. */
  notice?: string | null;
}

export function SignIn({ store, api, onSignedIn, notice }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useKeyboardForm();

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
    <form ref={form} className="app" onSubmit={submit}>
      <header>
        <h1>Gear Tracker</h1>
      </header>
      <main>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <label>
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            enterKeyHint="next"
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
            enterKeyHint="go"
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
        <PrivacyLink />
      </main>
      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>
          Sign in
        </button>
      </div>
    </form>
  );
}
