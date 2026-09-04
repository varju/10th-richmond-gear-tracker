import { type FormEvent, useEffect, useState } from "react";
import { type Api, ApiError, Offline, type PublicCode } from "../lib/api";
import { Contact } from "./Contact";
import { Page } from "./Page";

/**
 * What a stranger sees when they scan a sticker: whose it is and how to reach
 * us (FR-PUB-01), with a form to say where it is (FR-PUB-02). The item itself
 * is never named, so scanning a sticker cannot be used to browse our inventory
 * (NFR-SEC-03). The same URL a member scans, answered without an account.
 */
export function PublicItem({ api, code, onSignIn }: { api: Api; code: string; onSignIn: () => void }) {
  const [found, setFound] = useState<PublicCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.publicCode(code).then(
      ({ data }) => live && setFound(data),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof Offline) setError("No connection. This page needs one.");
        else setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [api, code]);

  const signIn = (
    <button type="button" onClick={onSignIn}>
      Sign in
    </button>
  );

  if (error)
    return (
      <Shell title="Gear Tracker" actions={signIn}>
        <p className="error" role="alert">
          {error}
        </p>
      </Shell>
    );

  if (!found)
    return (
      <Shell title="Gear Tracker">
        <p className="muted">Looking it up…</p>
      </Shell>
    );

  return (
    <Shell title={found.group.name || "Gear Tracker"} actions={signIn}>
      <p>Found this? Please tell us where it is.</p>
      {found.group.contact && (
        <p>
          <Contact contact={found.group.contact} />
        </p>
      )}
      <FoundForm api={api} code={code} />
    </Shell>
  );
}

/** The one thing the public can do: a note, and a way to reach them if they want (S-PUB-02). */
function FoundForm({ api, code }: { api: Api; code: string }) {
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.reportFound(code, { note: note.trim(), contact: contact.trim(), website });
      setSent(true);
    } catch (err) {
      if (err instanceof Offline) setError("No connection. Try again when you have one.");
      else if (err instanceof ApiError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <p className="confirmed" role="status">
        Thanks. We will be in touch.
      </p>
    );

  return (
    <form className="found-form" onSubmit={send}>
      <label>
        <span>Where is it?</span>
        <textarea required rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label>
        <span>How can we reach you? (optional)</span>
        <input value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="off" />
      </label>
      {/* Off screen. A person never fills it; a bot does, and the server drops the report (FR-PUB-04). */}
      <div className="hp" aria-hidden="true">
        <input
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy || !note.trim()}>
        Send
      </button>
    </form>
  );
}

/** The signed-in app's frame, without the app: no banner, no install prompt, no navigation. */
function Shell({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="app">
      <Page title={title} actions={actions}>
        {children}
      </Page>
    </div>
  );
}
