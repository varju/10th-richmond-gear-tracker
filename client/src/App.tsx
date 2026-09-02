import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, Offline } from "./lib/api";
import { STALE_PENDING_MS } from "./lib/clock";
import { ensurePersistent, type Persistence } from "./lib/storage";
import type { Store } from "./lib/store";
import { sync, type SyncOutcome } from "./lib/sync";
import { Banner } from "./ui/Banner";
import { Home } from "./ui/Home";
import { InstallPrompt } from "./ui/InstallPrompt";
import { PendingInterrupt } from "./ui/PendingInterrupt";
import { SignIn } from "./ui/SignIn";
import { useStore } from "./useStore";

interface Props {
  store: Store;
  api: Api;
  now?: () => number;
}

export function App({ store, api, now = Date.now }: Props) {
  useStore(store);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  const [persistence, setPersistence] = useState<Persistence>("persisted");
  const [interruptSeen, setInterruptSeen] = useState(false);
  const inFlight = useRef(false);

  // One sync at a time; a second request while one runs is dropped, not queued.
  const runSync = useCallback(async () => {
    if (inFlight.current || !store.meta.token) return;
    inFlight.current = true;
    setBusy(true);
    try {
      setOutcome(await sync(store, api, now));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [store, api, now]);

  // On open, on regaining connectivity, and when brought back to the front (FR-OFF-03).
  useEffect(() => {
    void runSync();
    const visible = () => document.visibilityState === "visible" && void runSync();
    window.addEventListener("online", runSync);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", runSync);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [runSync]);

  useEffect(() => {
    void ensurePersistent().then(setPersistence);
  }, []);

  async function signOut() {
    try {
      await api.signOut();
    } catch (e) {
      if (!(e instanceof Offline)) throw e;
    }
    await store.setMeta({ token: undefined, user: undefined });
  }

  if (!store.meta.token) return <SignIn store={store} api={api} onSignedIn={runSync} />;

  const pending = store.pending;
  const stale = pending.filter((e) => e.occurred_at < now() - STALE_PENDING_MS);
  return (
    <div className="app">
      <Banner pending={pending.length} busy={busy} outcome={outcome} />
      {persistence === "refused" && (
        <p className="notice" role="alert">
          The browser refused to protect this app’s storage. Unsent records could be deleted to free space. Sync often.
        </p>
      )}
      {stale.length > 0 && !interruptSeen ? (
        <PendingInterrupt
          count={stale.length}
          oldest={Math.min(...stale.map((e) => e.occurred_at))}
          now={now()}
          busy={busy}
          onSync={runSync}
          onContinue={() => setInterruptSeen(true)}
        />
      ) : (
        <>
          <InstallPrompt />
          <Home store={store} busy={busy} outcome={outcome} now={now} onSync={runSync} onSignOut={signOut} />
        </>
      )}
    </div>
  );
}
