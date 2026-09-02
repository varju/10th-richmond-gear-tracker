import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, Offline } from "./lib/api";
import { autoSync } from "./lib/autosync";
import { STALE_PENDING_MS } from "./lib/clock";
import { type Route, useRoute } from "./lib/router";
import { ensurePersistent, type Persistence } from "./lib/storage";
import type { Store } from "./lib/store";
import { sync, type SyncOutcome } from "./lib/sync";
import { unsaved } from "./lib/unsaved";
import { Banner } from "./ui/Banner";
import { Bind } from "./ui/Bind";
import { CodeLanding } from "./ui/CodeLanding";
import { Found } from "./ui/Found";
import { InstallPrompt } from "./ui/InstallPrompt";
import { Inventory } from "./ui/Inventory";
import { ItemPage } from "./ui/ItemPage";
import { LeaveDialog } from "./ui/LeaveDialog";
import { NewItem } from "./ui/NewItem";
import { Page } from "./ui/Page";
import { PendingInterrupt } from "./ui/PendingInterrupt";
import { PublicItem } from "./ui/PublicItem";
import { RepairPage } from "./ui/RepairPage";
import { Repairs } from "./ui/Repairs";
import { Report } from "./ui/Report";
import { Scan } from "./ui/Scan";
import { Settings } from "./ui/Settings";
import { SignIn } from "./ui/SignIn";
import { type Shell, ShellContext } from "./shell";
import { useStore } from "./useStore";

interface Props {
  store: Store;
  api: Api;
  now?: () => number;
}

export function App({ store, api, now = Date.now }: Props) {
  useStore(store);
  const route = useRoute();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  const [persistence, setPersistence] = useState<Persistence>("persisted");
  const [storageNoticeSeen, setStorageNoticeSeen] = useState(false);
  const [interruptSeen, setInterruptSeen] = useState(false);
  const [signInWanted, setSignInWanted] = useState(false);
  const inFlight = useRef(false);

  // One sync at a time; a second request while one runs is dropped, not queued.
  const runSync = useCallback(async (): Promise<SyncOutcome | undefined> => {
    if (inFlight.current || !store.meta.token) return undefined;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = await sync(store, api, now);
      setOutcome(outcome);
      return outcome;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [store, api, now]);

  // On open, on regaining connectivity, and when brought back to the front (FR-OFF-03).
  useEffect(() => {
    void runSync();
    const online = () => void runSync();
    const visible = () => document.visibilityState === "visible" && void runSync();
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [runSync]);

  // And the moment anything is unsent (FR-OFF-03).
  useEffect(() => autoSync(store, runSync), [store, runSync]);

  useEffect(() => {
    void ensurePersistent().then(setPersistence);
  }, []);

  // Closing or reloading the tab with a draft open gets the browser's own question.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (unsaved.any) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  async function signOut() {
    try {
      await api.signOut();
    } catch (e) {
      if (!(e instanceof Offline)) throw e;
    }
    await store.setMeta({ token: undefined, user: undefined });
  }

  if (!store.meta.token) {
    // A sticker's URL is the same signed in or out. Signed out it is a stranger
    // holding our gear, not a member who forgot to sign in (FR-PUB-01).
    const [head, second] = route.segments;
    if (head === "g" && second && !signInWanted)
      return <PublicItem api={api} code={second} onSignIn={() => setSignInWanted(true)} />;
    return <SignIn store={store} api={api} onSignedIn={runSync} />;
  }

  const shell: Shell = { busy, outcome, now, sync: runSync, signOut };
  const pending = store.pending;
  const stale = pending.filter((e) => e.occurred_at < now() - STALE_PENDING_MS);
  return (
    <ShellContext value={shell}>
      <div className="app">
        <Banner pending={pending} busy={busy} outcome={outcome} now={now} />
        {persistence === "refused" && !storageNoticeSeen && (
          <p className="notice" role="alert">
            The browser refused to protect this app’s storage. Unsent records could be deleted to free space. Sync
            often.
            <button type="button" onClick={() => setStorageNoticeSeen(true)}>
              Understood
            </button>
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
            {route.segments.length === 0 && <InstallPrompt />}
            <Screen store={store} api={api} route={route} shell={shell} />
          </>
        )}
        <LeaveDialog />
      </div>
    </ShellContext>
  );
}

function Screen({ store, api, route, shell }: { store: Store; api: Api; route: Route; shell: Shell }) {
  const [head, second] = route.segments;
  switch (head) {
    case undefined:
      return <Inventory store={store} />;
    case "items":
      if (second === "new") return <NewItem store={store} code={route.query.get("code")} />;
      if (second) return <ItemPage store={store} id={second} />;
      break;
    case "scan":
      return <Scan store={store} />;
    case "out":
      return <Report store={store} />;
    case "g":
      if (second) return <CodeLanding store={store} code={second} />;
      break;
    case "bind":
      if (second) return <Bind store={store} code={second} />;
      break;
    case "found":
      return <Found store={store} />;
    case "repairs":
      return second ? <RepairPage store={store} id={second} /> : <Repairs store={store} />;
    case "settings":
      return <Settings store={store} api={api} shell={shell} />;
  }
  return (
    <Page title="Not found" back="/">
      <p>Nothing lives at {route.path}.</p>
    </Page>
  );
}
