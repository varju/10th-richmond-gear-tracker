import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { bindCode, seen } from "../lib/actions";
import { matchingEvents } from "../lib/calendar";
import { parseCode } from "../lib/codes";
import {
  code as codeOf,
  codeStatus,
  displayName,
  homeLabel,
  isPool,
  item,
  nameOf,
  poolCounts,
  resolveItem,
} from "../lib/inventory";
import { checkOut } from "../lib/movement";
import { addExtra, isPacked, type Remaining, remaining, type Reservation, reservation } from "../lib/reservations";
import { back, navigate, useRoute } from "../lib/router";
import { confirmRead, READ_MS, type Scanner, startScanner, unlockSound } from "../lib/scanner";
import type { Store } from "../lib/store";
import { NATIVE } from "../lib/server";
import { type Session, sessionEvent, setSessionEvent } from "../lib/session";
import { guard, useUnsaved } from "../lib/unsaved";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { PoolActions } from "./ItemPage";
import { EventSuggestions } from "./EventChoice";
import { holdingLabel, statusLabel, userName } from "./labels";
import { CONFIRM_MS, MoveActions, useFlash } from "./MoveActions";
import { useLight, WithLight } from "./Light";
import { Page } from "./Page";

const FLASH_MS = 2000;
/** How long after a move the same sticker is ignored: long enough to lower the phone, short enough to undo a mistake. */
export const RESCAN_MS = 3000;

/**
 * The movement session: the camera, full screen, kept running for the whole
 * visit. A code on an item shows a card over the viewfinder; one tap moves it
 * and the next scan is taken (FR-OUT-03, FR-OUT-06). An unassigned code goes to
 * /g/<code>. With ?for=<itemId> the code is a replacement sticker for that item
 * and is bound here (FR-TAG-04). With ?reservation=<id> the session is seeded
 * with that reservation's gear (FR-RES-02). There is no mode: the card offers
 * the move that fits the item's state (FR-OUT-06). The first check-out or
 * transfer of a session asks for the event (FR-OUT-05). An item just moved is not
 * shown again for three seconds, since the camera is still on the sticker when
 * the card closes. After that a rescan shows it again, so a wrong check-out is
 * undone by scanning it and tapping Return.
 */
/** `native`: the iPhone app's scanner, where there is one (lib/scanner.ts). */
export function Scan({ store, native = NATIVE }: { store: Store; native?: boolean }) {
  useStore(store);
  const route = useRoute();
  const query = route.query;
  const forItem = query.get("for");
  const { now } = useShell();
  const booked = reservation(store.state, query.get("reservation") ?? "");
  // State, not a ref: the menu replaces the viewfinder, and closing it brings a new video that needs a new scanner.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const target = useRef<HTMLDivElement>(null);
  const [flash, say] = useFlash(FLASH_MS);
  const [confirmed, confirm] = useFlash(CONFIRM_MS);
  // The read flash: green target, dimmed frame. It shows through the card opening, so a read is seen even where
  // the phone cannot buzz (iOS).
  const [read, flashRead] = useFlash(READ_MS);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const { light, ready, gone, toggle } = useLight();
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [cardItem, setCardItem] = useState<string | null>(null);
  // The decode loop keeps running behind the card; its reads are dropped until the card closes.
  const cardOpen = useRef(false);
  // When each item was last moved here; a decode within RESCAN_MS of that is the camera still on the sticker.
  const moved = useRef(new Map<string, number>());
  const scanner = useRef<Scanner | null>(null);
  // The first check-out of a session asks its event (FR-OUT-05); a reservation's session has the reservation's (FR-RES-03).
  const packing: Session | undefined = booked ? { event: booked.event, reservation_id: booked.id } : undefined;
  const me = store.meta.user?.id;

  // The card opening freezes the frame on the sticker, so a read looks like a read; it
  // un-freezes when the card closes, whether by a move or by Skip.
  const showCard = (id: string | null) => {
    cardOpen.current = id !== null;
    setCardItem(id);
    if (id !== null) scanner.current?.pause();
    else scanner.current?.resume();
  };

  const handle = useCallback(
    async (text: string) => {
      const id = parseCode(text);
      if (!id) return say("Not a gear code");
      const status = codeStatus(store.state, id);
      if (status === "unknown") return say("Not one of our codes");
      if (!forItem) {
        if (status === "unassigned") {
          confirmRead();
          return navigate(`/g/${id}`);
        }
        const bound = codeOf(store.state, id)?.item_id;
        const itemId = bound ? resolveItem(store.state, bound) : null;
        const movedAt = itemId ? moved.current.get(itemId) : undefined;
        // The camera is still on the sticker just moved: no buzz, and the target goes amber, not green.
        if (movedAt !== undefined && Date.now() - movedAt < RESCAN_MS) return flashRead("ignored");
        confirmRead();
        flashRead("read");
        if (itemId) await seen(store, itemId);
        return showCard(itemId);
      }
      confirmRead();
      flashRead("read");
      if (status !== "unassigned") {
        const owner = resolveItem(store.state, codeOf(store.state, id)?.item_id ?? "");
        return say(`That code is already on ${nameOf(store.state, owner)}`);
      }
      try {
        await bindCode(store, id, forItem);
      } catch (e) {
        return say(e instanceof Error ? e.message : "Could not bind the code");
      }
      navigate(`/items/${forItem}`, true);
    },
    [store, forItem, say, flashRead],
  );

  // The scanner closes over the latest handler without restarting the camera on every render.
  const latest = useRef(handle);
  latest.current = handle;

  // Sound needs a tap on iOS: the one that opened this screen, or any tap while it is open.
  useEffect(() => {
    unlockSound();
    document.addEventListener("pointerdown", unlockSound);
    return () => document.removeEventListener("pointerdown", unlockSound);
  }, []);

  useEffect(() => {
    if (!video) return;
    const started = startScanner(
      video,
      (text) => {
        if (!cardOpen.current) void latest.current(text);
      },
      {
        target: () => target.current,
        onError: setCameraError,
        onReady: ({ torch }) => {
          setCameraError(null);
          ready(started, torch);
        },
      },
      undefined,
      native,
    );
    scanner.current = started;
    if (cardOpen.current) started.pause();
    return () => {
      scanner.current = null;
      gone();
      started.stop();
    };
  }, [video, native, ready, gone]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = typed;
    setTyped("");
    void handle(text);
  }

  const card = cardItem ? item(store.state, cardItem) : undefined;

  return (
    <Page
      title={forItem ? "Scan new code" : booked ? "Pack" : "Scan"}
      back={forItem ? `/items/${forItem}` : booked ? `/reservations/${booked.id}` : "/"}
      actions={
        card ? undefined : (
          <>
            {booked && <Finish store={store} booked={booked} />}
            <WithLight light={light} onToggle={toggle}>
              {typing ? (
                <form onSubmit={submit} className="scan-typed">
                  <input
                    aria-label="Code or URL"
                    placeholder="Code or URL"
                    autoFocus
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                  />
                  <button type="submit" className="primary">
                    Go
                  </button>
                </form>
              ) : (
                <button type="button" onClick={() => setTyping(true)}>
                  Type a code instead
                </button>
              )}
            </WithLight>
          </>
        )
      }
    >
      {/* Packing takes the reservation's event, always (FR-RES-03); plain scanning has its own session (FR-OUT-05). */}
      {!forItem &&
        (booked ? (
          <div className="session">
            <span>{booked.event ? `Event: ${booked.event}` : "No event"}</span>
          </div>
        ) : (
          <SessionEvent store={store} />
        ))}
      <div className={read ? `viewfinder ${read}` : "viewfinder"}>
        <video ref={setVideo} muted playsInline hidden={cameraError !== null} />
        {!cameraError && (!card || read) && <div ref={target} className="target" aria-hidden="true" />}
        {cameraError ? (
          <p className="scan-error" role="alert">
            {cameraError}
          </p>
        ) : (
          <p className="scan-hint">{forItem ? "Point at the new sticker" : "Point at a code"}</p>
        )}
        {flash && (
          <p className="scan-flash" role="status">
            {flash}
          </p>
        )}
        {confirmed && (
          <p className="confirmed" role="status">
            {confirmed}
          </p>
        )}
        {card && isPool(card) && (
          <section className="move-card" aria-labelledby="move-card-title">
            <h2 id="move-card-title">{displayName(store.state, card)}</h2>
            <p className="muted">
              {poolCounts(card).in} in of {poolCounts(card).owned}
            </p>
            <PoolActions
              store={store}
              it={card}
              session={packing}
              onMoved={(message, kind) => {
                confirm(message);
                showCard(null);
                moved.current.set(card.id, Date.now());
                // A count taken during a reservation session grows its line (FR-RES-07).
                if (booked && kind === "out") void addExtra(store, booked.id, card.id);
              }}
            >
              <CardButtons id={card.id} onSkip={() => showCard(null)} />
            </PoolActions>
          </section>
        )}
        {card && !isPool(card) && (
          <section className="move-card" aria-labelledby="move-card-title">
            <h2 id="move-card-title">{displayName(store.state, card)}</h2>
            <p>{holdingLabel(store.state, card, me, now())}</p>
            {homeLabel(store.state, card) && (
              // Where it goes back, big, whenever Return is on offer (FR-OUT-10).
              <p className={card.status === "out" ? "move-home" : "muted"}>
                {card.status === "out" ? `Put it back: ${homeLabel(store.state, card)}` : homeLabel(store.state, card)}
              </p>
            )}
            <MoveActions
              store={store}
              it={card}
              session={packing}
              onMoved={(kind, to) => {
                confirm(
                  `${to ? `Transferred to ${userName(store.state, to)}` : kind} · ${displayName(store.state, card)}`,
                );
                showCard(null);
                moved.current.set(card.id, Date.now());
                // An extra taken during a reservation session joins its gear list (FR-RES-07).
                // Gear handed to someone else is not packed for it (FR-OUT-26).
                if (booked && kind !== "Returned" && !to) void addExtra(store, booked.id, card.id);
              }}
              onSaved={(message) => {
                confirm(`${message} · ${displayName(store.state, card)}`);
                showCard(null);
                // The camera is still on the sticker; the card must not open again at once.
                moved.current.set(card.id, Date.now());
              }}
            >
              <CardButtons id={card.id} onSkip={() => showCard(null)} />
            </MoveActions>
          </section>
        )}
      </div>
      {booked && (
        <RemainingList
          store={store}
          booked={booked}
          onMoved={(id, name) => {
            moved.current.set(id, Date.now());
            confirm(`Checked out · ${name}`);
          }}
          onOut={showCard}
        />
      )}
    </Page>
  );
}

/** The scan card's way out: the full item, its edit form, or the next scan (FR-OUT-11). */
function CardButtons({ id, onSkip }: { id: string; onSkip: () => void }) {
  return (
    <>
      <div className="row">
        <button type="button" onClick={() => guard(() => navigate(`/items/${id}`))}>
          Open item
        </button>
        <button type="button" onClick={() => guard(() => navigate(`/items/${id}?edit=1`))}>
          Edit
        </button>
      </div>
      <button type="button" onClick={() => guard(onSkip)}>
        Skip
      </button>
    </>
  );
}

/**
 * What the reservation still needs, always in view (FR-RES-02), by home (FR-RES-06).
 * A row is a check-out for gear with no sticker (FR-OUT-02). Derived from state,
 * so a scan on another device ticks it here once both have synced. Packed lines
 * are hidden by default; "Show packed" brings them back, ticked, to confirm what
 * went (FR-RES-21). A line never returned from the last trip names who has it, and
 * its tap opens the card, where a transfer is offered (FR-RES-22, FR-OUT-12).
 */
function RemainingList({
  store,
  booked,
  onMoved,
  onOut,
}: {
  store: Store;
  booked: Reservation;
  onMoved: (id: string, name: string) => void;
  onOut: (id: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [showPacked, setShowPacked] = useState(false);
  const rem = remaining(store.state, booked);

  async function take(id: string, name: string) {
    setError(null);
    try {
      await checkOut(store, id, { event: booked.event, reservation_id: booked.id, packing: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the move");
      return;
    }
    onMoved(id, name);
  }

  return (
    <section className="remaining" aria-label="Remaining">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {isPacked(rem) && <p className="muted">Everything is packed.</p>}
      {rem.items.length > 0 && (
        <ul className="items">
          {rem.items.map((it) => {
            const out = it.status === "out";
            return (
              <li key={it.id}>
                <button
                  className="item"
                  type="button"
                  onClick={() => (out ? onOut(it.id) : take(it.id, displayName(store.state, it)))}
                >
                  <span className="item-name">{displayName(store.state, it)}</span>
                  <span className="muted small">
                    {out ? statusLabel(store.state, it) : homeLabel(store.state, it) || "No home"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {rem.generics.length > 0 && (
        <ul className="names">
          {rem.generics.map((g) => (
            <li key={g.generic.id} className={g.done >= g.quantity ? "muted" : ""}>
              {g.done} of {g.quantity} × {g.generic.name}
            </li>
          ))}
        </ul>
      )}
      {rem.packed.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={showPacked} onChange={(e) => setShowPacked(e.target.checked)} />
          <span>Show packed</span>
        </label>
      )}
      {showPacked && rem.packed.length > 0 && (
        <ul className="names">
          {rem.packed.map((it) => (
            <li key={it.id} className="muted">
              ✓ {displayName(store.state, it)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Ending the session names what was not scanned, and lets the person finish anyway (FR-RES-04). */
function Finish({ store, booked }: { store: Store; booked: Reservation }) {
  const [asking, setAsking] = useState(false);
  const rem: Remaining = remaining(store.state, booked);
  const done = () => back(`/reservations/${booked.id}`);
  const left = [
    ...rem.items.map((it) => displayName(store.state, it)),
    ...rem.generics.filter((g) => g.done < g.quantity).map((g) => `${g.quantity - g.done} × ${g.generic.name}`),
  ];

  if (asking && left.length > 0) {
    return (
      <div className="finish" role="group" aria-label="Finish">
        <p className="notice" role="alert">
          Not scanned: {left.join(", ")}.
        </p>
        <div className="row">
          <button type="button" className="warn" onClick={done}>
            Finish anyway
          </button>
          <button type="button" onClick={() => setAsking(false)}>
            Keep packing
          </button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" onClick={() => (left.length === 0 ? done() : setAsking(true))}>
      Finish
    </button>
  );
}

/**
 * The plain scanning session's event, until changed, cleared, or the session ends (FR-OUT-05,
 * FR-OUT-38). A setting on this device. A move re-checks it when made, so an event shown here that
 * has since ended asks again rather than recording nothing.
 */
function SessionEvent({ store }: { store: Store }) {
  const { event } = sessionEvent(store.meta, store.now());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  useUnsaved(editing && draft.trim() !== (event ?? ""), { save: () => apply().then(() => true) });

  async function apply() {
    await setSessionEvent(store, draft.trim() || undefined);
    setEditing(false);
  }

  function set(e: FormEvent) {
    e.preventDefault();
    void apply();
  }

  async function clear() {
    await setSessionEvent(store, undefined);
    setEditing(false);
  }

  /** Tapping a calendar suggestion sets the name at once, the same one tap a scan takes (FR-RES-20). */
  async function pick(name: string) {
    await setSessionEvent(store, name);
    setEditing(false);
  }

  if (editing) {
    const suggestions = matchingEvents(store.meta.calendar_events, draft);
    return (
      <form className="session" onSubmit={set}>
        <input
          aria-label="Event"
          placeholder="Event, e.g. Spring camp"
          autoFocus
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="minor primary">
          Set
        </button>
        <button type="button" className="minor" onClick={clear}>
          Clear
        </button>
        {suggestions.length > 0 && <EventSuggestions events={suggestions} onPick={(name) => void pick(name)} />}
      </form>
    );
  }
  return (
    <div className="session">
      <span>{event ? `Event: ${event}` : "No event"}</span>
      <button
        type="button"
        className="minor"
        onClick={() => {
          setDraft(event ?? "");
          setEditing(true);
        }}
      >
        Change
      </button>
    </div>
  );
}
