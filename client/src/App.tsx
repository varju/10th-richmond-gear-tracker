import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, Offline } from "./lib/api";
import { autoSync, pollSync } from "./lib/autosync";
import { STALE_PENDING_MS } from "./lib/clock";
import { group } from "./lib/inventory";
import { navigate, type Route, useRoute } from "./lib/router";
import { ensurePersistent } from "./lib/storage";
import type { Store } from "./lib/store";
import { sync, type SyncOutcome } from "./lib/sync";
import { unsaved } from "./lib/unsaved";
import { useWide } from "./lib/wide";
import { Banner } from "./ui/Banner";
import { Bind } from "./ui/Bind";
import { CodeLanding } from "./ui/CodeLanding";
import { Conflicts } from "./ui/Conflicts";
import { Desk } from "./ui/Desk";
import { Found } from "./ui/Found";
import { Help } from "./ui/Help";
import { Home } from "./ui/Home";
import { InstallPrompt } from "./ui/InstallPrompt";
import { Inventory } from "./ui/Inventory";
import { ItemTable } from "./ui/ItemTable";
import { ItemPage } from "./ui/ItemPage";
import { Join } from "./ui/Join";
import { LeaveDialog } from "./ui/LeaveDialog";
import { Mail } from "./ui/Mail";
import { NewItem, NewUnit } from "./ui/NewItem";
import { Page } from "./ui/Page";
import { PendingInterrupt } from "./ui/PendingInterrupt";
import { PublicItem } from "./ui/PublicItem";
import { RepairPage } from "./ui/RepairPage";
import { Repairs } from "./ui/Repairs";
import { Report } from "./ui/Report";
import { Reports } from "./ui/Reports";
import { ReservationForm } from "./ui/ReservationForm";
import { ReservationPage } from "./ui/ReservationPage";
import { Reservations } from "./ui/Reservations";
import { Scan } from "./ui/Scan";
import { Sections } from "./ui/Sections";
import { Settings } from "./ui/Settings";
import { SettingsAssistant } from "./ui/SettingsAssistant";
import { SettingsCategories } from "./ui/SettingsCategories";
import { SettingsCodes } from "./ui/SettingsCodes";
import { SettingsCsv } from "./ui/SettingsCsv";
import { SettingsDevices } from "./ui/SettingsDevices";
import { SettingsGroup } from "./ui/SettingsGroup";
import { SettingsLocations } from "./ui/SettingsLocations";
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
  const wide = useWide();
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

  // A screen that just sits there still hears about another device's work.
  useEffect(() => pollSync(runSync), [runSync]);

  // Asked, not relied on. iOS says no; the unsent count is the warning (NFR-DATA-11).
  useEffect(() => {
    void ensurePersistent();
  }, []);

  // Whose gear this is, in the tab and under the home-screen icon. One server, one group.
  const groupName = group(store.state).name;
  useEffect(() => {
    document.title = groupName ? `${groupName} · Gear Tracker` : "Gear Tracker";
    // The icon's name comes from the manifest, which the server rewrites. Older
    // iOS reads this tag instead, so it says the same thing.
    let tag = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
    if (!tag) {
      tag = document.createElement("meta");
      tag.name = "apple-mobile-web-app-title";
      document.head.appendChild(tag);
    }
    tag.content = groupName ? `${groupName} Gear` : "Gear";
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
    // An invite or reset link (FR-USR-12). Once redeemed, the device is signed in and starts at home.
    if (head === "join") return <Join store={store} api={api} onJoined={() => joined()} />;
    return <SignIn store={store} api={api} onSignedIn={runSync} />;
  }

  const shell: Shell = { busy, outcome, now, sync: runSync, signOut, api, store };
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
        ) : wide ? (
          // At a desk every screen keeps the sections beside it (NFR-USE-10).
          <div className="desk">
            <Sections store={store} layout="sidebar" />
            <div className="desk-main">
              <Screen store={store} api={api} route={route} shell={shell} wide />
            </div>
          </div>
        ) : (
          <>
            {/* Installing matters on the phone that goes to the locker, and only there. */}
            {route.segments.length === 0 && <InstallPrompt />}
            <Screen store={store} api={api} route={route} shell={shell} wide={false} />
          </>
        )}
        <LeaveDialog />
      </div>
    </ShellContext>
  );
}

function Screen({
  store,
  api,
  route,
  shell,
  wide,
}: {
  store: Store;
  api: Api;
  route: Route;
  shell: Shell;
  wide: boolean;
}) {
  const [head, second, third] = route.segments;
  switch (head) {
    case undefined:
      // The locker opens on what it came to do; the desk opens on what needs a person.
      return wide ? <Desk store={store} /> : <Home store={store} />;
    case "items":
      if (!second) return wide ? <ItemTable store={store} /> : <Inventory store={store} />;
      if (second === "new") {
        const parent = route.query.get("parent");
        const code = route.query.get("code");
        // Another of a generic, or something on its own (FR-INV-24).
        return parent ? <NewUnit store={store} parent={parent} code={code} /> : <NewItem store={store} code={code} />;
      }
      return <ItemPage store={store} id={second} />;
    case "scan":
      return <Scan store={store} />;
    case "out":
      return <Report store={store} />;
    case "reports":
      return <Reports store={store} />;
    case "g":
      if (second) return <CodeLanding store={store} code={second} />;
      break;
    case "bind":
      if (second) return <Bind store={store} code={second} />;
      break;
    case "found":
      return <Found store={store} />;
    case "help":
      return <Help />;
    case "conflicts":
      return <Conflicts store={store} />;
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
      if (second === "group") return <SettingsGroup store={store} />;
      if (second === "locations") return <SettingsLocations store={store} />;
      if (second === "categories") return <SettingsCategories store={store} />;
      if (second === "codes") return <SettingsCodes store={store} api={api} shell={shell} />;
      if (second === "csv") return <SettingsCsv store={store} api={api} shell={shell} />;
      if (second === "devices") return <SettingsDevices store={store} api={api} />;
      if (second === "assistant") return <SettingsAssistant api={api} />;
      return <Settings store={store} shell={shell} />;
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
