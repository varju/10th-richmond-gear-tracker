import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, Offline } from "./lib/api";
import { autoSync } from "./lib/autosync";
import { STALE_PENDING_MS } from "./lib/clock";
import { group } from "./lib/inventory";
import { navigate, type Route, useRoute } from "./lib/router";
import { ensurePersistent } from "./lib/storage";
import type { Store } from "./lib/store";
import { sync, type SyncOutcome } from "./lib/sync";
import { unsaved } from "./lib/unsaved";
import { Banner } from "./ui/Banner";
import { Bind } from "./ui/Bind";
import { CodeLanding } from "./ui/CodeLanding";
import { Conflicts } from "./ui/Conflicts";
import { Found } from "./ui/Found";
import { InstallPrompt } from "./ui/InstallPrompt";
import { Inventory } from "./ui/Inventory";
import { LocationPage, Locations } from "./ui/Locations";
import { ItemPage } from "./ui/ItemPage";
import { Join } from "./ui/Join";
import { LeaveDialog } from "./ui/LeaveDialog";
import { Mail } from "./ui/Mail";
import { NewItem } from "./ui/NewItem";
import { Page } from "./ui/Page";
import { PendingInterrupt } from "./ui/PendingInterrupt";
import { PublicItem } from "./ui/PublicItem";
import { RepairPage } from "./ui/RepairPage";
import { Repairs } from "./ui/Repairs";
import { Report } from "./ui/Report";
import { ReservationForm } from "./ui/ReservationForm";
import { ReservationPage } from "./ui/ReservationPage";
import { Reservations } from "./ui/Reservations";
import { Scan } from "./ui/Scan";
import { Settings } from "./ui/Settings";
import { StockCheck } from "./ui/StockCheck";
import { SignIn } from "./ui/SignIn";
import { Users } from "./ui/Users";
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

  // Asked, not relied on. iOS says no; the unsent count is the warning (NFR-DATA-11).
  useEffect(() => {
    void ensurePersistent();
  }, []);

  // Whose gear this is, in the tab and under the home-screen icon. One server, one group.
  const groupName = group(store.state).name;
  useEffect(() => {
    document.title = groupName ? `${groupName} · Gear Tracker` : "Gear Tracker";
  }, [groupName]);

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

  function joined() {
    navigate("/", true);
    void runSync();
  }

  if (!store.meta.token) {
    // A sticker's URL is the same signed in or out. Signed out it is a stranger
    // holding our gear, not a member who forgot to sign in (FR-PUB-01).
    const [head, second] = route.segments;
    if (head === "g" && second && !signInWanted)
      return <PublicItem api={api} code={second} onSignIn={() => setSignInWanted(true)} />;
    // An invite or reset link (FR-USR-12). Once redeemed, the phone is signed in and starts at home.
    if (head === "join") return <Join store={store} api={api} onJoined={() => joined()} />;
    return <SignIn store={store} api={api} onSignedIn={runSync} />;
  }

  const shell: Shell = { busy, outcome, now, sync: runSync, signOut, api };
  const pending = store.pending;
  const stale = pending.filter((e) => e.occurred_at < now() - STALE_PENDING_MS);
  return (
    <ShellContext value={shell}>
      <div className="app">
        <Banner pending={pending} busy={busy} outcome={outcome} now={now} />
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
  const [head, second, third] = route.segments;
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
    case "conflicts":
      return <Conflicts store={store} />;
    case "locations":
      return second ? <LocationPage store={store} id={second} /> : <Locations store={store} />;
    case "stock-check":
      return <StockCheck store={store} />;
    case "repairs":
      return second ? <RepairPage store={store} id={second} /> : <Repairs store={store} />;
    case "reservations":
      if (second === "new") return <ReservationForm store={store} from={route.query.get("from")} />;
      if (second && third === "edit") return <ReservationForm store={store} id={second} />;
      if (second) return <ReservationPage store={store} id={second} />;
      return <Reservations store={store} />;
    case "settings":
      if (second === "users") return <Users store={store} api={api} />;
      if (second === "mail") return <Mail store={store} api={api} />;
      return <Settings store={store} api={api} shell={shell} />;
    case "join":
      // Signed in already. Join says what to do; it needs no shell.
      return <Join store={store} api={api} onJoined={() => undefined} />;
  }
  return (
    <Page title="Not found" back="/">
      <p>Nothing lives at {route.path}.</p>
    </Page>
  );
}
