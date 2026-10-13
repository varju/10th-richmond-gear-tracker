import { type FormEvent, useEffect, useState } from "react";
import { type Api, ApiError, Offline } from "../lib/api";
import { navigate, useRoute } from "../lib/router";
import { NATIVE } from "../lib/server";
import type { Store } from "../lib/store";
import { useKeyboardForm } from "./keyboardForm";

interface Props {
  store: Store;
  api: Api;
  onJoined: () => void;
  /** Signed in already: the app's own sign-out, so the link can be used for another account. */
  onSignOut?: () => Promise<void>;
  native?: boolean;
}

const MIN_PASSWORD = 8;
/** The server's cap (NFR-SEC-21). */
const MAX_PASSWORD = 256;

/**
 * Where an invite or reset link lands: /join?token=… (FR-USR-12). Set a password,
 * and this device is signed in. The link is spent either way.
 *
 * A standing join link lands here too, told apart by `?link=` instead of `?token=` (FR-USR-19):
 * whoever opens it has no account yet, so the form also asks for a name and email, and the link
 * itself is not spent by their joining.
 *
 * This device already signed in: any of these links is sent straight home, as if it had opened
 * the root URL. Whoever is signed in already has no use for a join link, and the sticker is also
 * how a member gets back in day to day.
 *
 * In the iPhone app a tapped link opens here instead of in Safari, where it would still have
 * worked. So the app says who is signed in, and offers to sign out and use the link.
 */
export function Join({ store, api, onJoined, onSignOut, native = NATIVE }: Props) {
  const query = useRoute().query;
  const token = query.get("token") ?? "";
  const link = query.get("link") ?? "";
  const standing = link !== "";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Which field the error is about. */
  const [fault, setFault] = useState<"password" | "again" | null>(null);
  // Why the form is not shown: a link that already worked once (FR-USR-12), which kind decides
  // what the person can do next, or an email that already has an account (FR-USR-19).
  const [blocked, setBlocked] = useState<"invite" | "reset" | "exists" | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useKeyboardForm();
  const signedIn = store.meta.user;

  const offerSignOut = native && Boolean(onSignOut);
  const pending = store.pending.length;

  // Already signed in on this device: home, not a dead end asking to sign out first.
  useEffect(() => {
    if (signedIn && !offerSignOut) navigate("/", true);
  }, [signedIn, offerSignOut]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setFault("password");
      return setError(`Use at least ${MIN_PASSWORD} characters.`);
    }
    if (password.length > MAX_PASSWORD) {
      setFault("password");
      return setError(`Use at most ${MAX_PASSWORD} characters.`);
    }
    if (password !== again) {
      setFault("again");
      return setError("The two passwords differ.");
    }
    setBusy(true);
    setError(null);
    setFault(null);
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
      else if (e instanceof ApiError && e.code === "common_password") {
        // On the server's list of common passwords (NFR-SEC-22).
        setFault("password");
        setError("This password is too common. Choose another.");
      } else if (e instanceof ApiError) setError(e.message);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={form} className="app" onSubmit={submit} noValidate>
      <header>
        <h1>Gear Tracker</h1>
      </header>
      <main>
        {signedIn ? (
          offerSignOut && (
            <>
              <p>You are signed in as {signedIn.name}. This link is for a new account, or for someone else's.</p>
              <div className="actions">
                <button
                  className="primary"
                  type="button"
                  onClick={() => void onSignOut?.()}
                  disabled={busy || pending > 0}
                >
                  Sign out and use the link
                </button>
                <button type="button" onClick={() => navigate("/", true)}>
                  Stay signed in
                </button>
              </div>
              {pending > 0 && <p className="muted small">Sign out after your unsent records are sent.</p>}
            </>
          )
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
                    enterKeyHint="next"
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
                    enterKeyHint="next"
                  />
                </label>
              </>
            )}
            <label>
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                enterKeyHint="next"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setFault(null);
                }}
                aria-invalid={fault === "password" || undefined}
                required
                minLength={MIN_PASSWORD}
              />
            </label>
            <label>
              <span>Again</span>
              <input
                type="password"
                autoComplete="new-password"
                enterKeyHint="go"
                value={again}
                onChange={(e) => {
                  setAgain(e.target.value);
                  setFault(null);
                }}
                aria-invalid={fault === "again" || undefined}
                required
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {standing && (
              <p className="muted small">
                Already have an account?{" "}
                <button className="link" type="button" onClick={() => navigate("/", true)}>
                  Log in
                </button>
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
