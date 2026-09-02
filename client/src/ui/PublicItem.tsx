import { useEffect, useState } from "react";
import { type Api, Offline, type PublicCode } from "../lib/api";
import { Page } from "./Page";

/**
 * What a stranger sees when they scan a sticker: the item, whose it is, and how
 * to reach us (FR-PUB-01). The same URL a member scans, answered without an
 * account. It fetches one public route and shows what comes back, so there is
 * nothing here to leak (NFR-SEC-03).
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
      <p className="big">{found.item?.name ?? "Our gear"}</p>
      <p>Found this? Please tell us where it is.</p>
      {found.group.contact && (
        <p>
          <Contact contact={found.group.contact} />
        </p>
      )}
    </Shell>
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

/** A tappable contact when we can tell what it is, and the plain text when we cannot. */
function Contact({ contact }: { contact: string }) {
  const href = /^https?:\/\//i.test(contact)
    ? contact
    : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)
      ? `mailto:${contact}`
      : null;
  return href ? <a href={href}>{contact}</a> : <>{contact}</>;
}
