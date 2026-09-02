import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { bindCode, seen } from "../lib/actions";
import { parseCode } from "../lib/codes";
import { code as codeOf, codeStatus, displayName, homeLabel, item, nameOf, resolveItem } from "../lib/inventory";
import { checkOut } from "../lib/movement";
import { addExtra, isPacked, type Remaining, remaining, type Reservation, reservation } from "../lib/reservations";
import { navigate, useRoute } from "../lib/router";
import { startScanner } from "../lib/scanner";
import type { Store } from "../lib/store";
import { guard, useUnsaved } from "../lib/unsaved";
import { useStore } from "../useStore";
import { statusLabel } from "./labels";
import { CONFIRM_MS, MoveActions, useFlash } from "./MoveActions";
import { Page } from "./Page";

const FLASH_MS = 2000;

/**
 * The movement session: the camera, full screen, kept running for the whole
 * visit. A code on an item shows a card over the viewfinder; one tap moves it
 * and the next scan is taken (FR-OUT-03, FR-OUT-06). An unassigned code goes to
 * /g/<code>. With ?for=<itemId> the code is a replacement sticker for that item
 * and is bound here (FR-TAG-04). With ?reservation=<id> the session is seeded
 * with that reservation's gear (FR-RES-02).
 */
export function Scan({ store }: { store: Store }) {
  useStore(store);
  const query = useRoute().query;
  const forItem = query.get("for");
  const booked = reservation(store.state, query.get("reservation") ?? "");
  const video = useRef<HTMLVideoElement>(null);
  const [flash, say] = useFlash(FLASH_MS);
  const [confirmed, confirm] = useFlash(CONFIRM_MS);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [cardItem, setCardItem] = useState<string | null>(null);
  // The decode loop keeps running behind the card; its reads are dropped until the card closes.
  const cardOpen = useRef(false);

  const showCard = (id: string | null) => {
    cardOpen.current = id !== null;
    setCardItem(id);
  };

  const handle = useCallback(
    async (text: string) => {
      const id = parseCode(text);
      if (!id) return say("Not a gear code");
      const status = codeStatus(store.state, id);
      if (status === "unknown") return say("Not one of our codes");
      if (!forItem) {
        if (status === "unassigned") return navigate(`/g/${id}`);
        const bound = codeOf(store.state, id)?.item_id;
        const itemId = bound ? resolveItem(store.state, bound) : null;
        if (itemId) await seen(store, itemId);
        return showCard(itemId);
      }
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
    [store, forItem, say],
  );

  // The scanner closes over the latest handler without restarting the camera on every render.
  const latest = useRef(handle);
  latest.current = handle;

  useEffect(() => {
    if (!video.current) return;
    const scanner = startScanner(
      video.current,
      (text) => {
        if (!cardOpen.current) void latest.current(text);
      },
      { onError: setCameraError },
    );
    return () => scanner.stop();
  }, []);

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
            {typing && (
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
            )}
            {!typing && (
              <button type="button" onClick={() => setTyping(true)}>
                Type a code instead
              </button>
            )}
          </>
        )
      }
    >
      {!forItem && <SessionEvent store={store} booked={booked} />}
      <div className="viewfinder">
        <video ref={video} muted playsInline hidden={cameraError !== null} />
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
        {card && (
          <section className="move-card" aria-labelledby="move-card-title">
            <h2 id="move-card-title">{displayName(store.state, card)}</h2>
            {homeLabel(store.state, card) && (
              <p className={card.status === "out" ? "move-home" : "muted"}>
                {card.status === "out" ? `Put it back: ${homeLabel(store.state, card)}` : homeLabel(store.state, card)}
              </p>
            )}
            <p>{statusLabel(store.state, card)}</p>
            <MoveActions
              store={store}
              it={card}
              onMoved={(kind) => {
                confirm(`${kind} · ${displayName(store.state, card)}`);
                showCard(null);
                // An extra taken during a reservation session joins its gear list (FR-RES-07).
                if (booked && kind !== "Checked in") void addExtra(store, booked.id, card.id);
              }}
            >
              <div className="row">
                {card.retired ? (
                  <button type="button" onClick={() => guard(() => navigate(`/items/${card.id}`))}>
                    Open item
                  </button>
                ) : (
                  <button type="button" onClick={() => guard(() => navigate(`/items/${card.id}?edit=1`))}>
                    Edit
                  </button>
                )}
                <button type="button" onClick={() => guard(() => showCard(null))}>
                  Skip
                </button>
              </div>
              {card.retired && (
                <button type="button" onClick={() => guard(() => navigate(`/items/${card.id}?edit=1`))}>
                  Edit
                </button>
              )}
            </MoveActions>
          </section>
        )}
      </div>
      {booked && <RemainingList store={store} booked={booked} onMoved={(name) => confirm(`Checked out · ${name}`)} />}
    </Page>
  );
}

/**
 * What the reservation still needs, always in view (FR-RES-02), by home (FR-RES-06).
 * A row is a check-out for gear with no sticker (FR-OUT-02). Derived from state,
 * so a scan on another phone ticks it here once both have synced.
 */
function RemainingList({
  store,
  booked,
  onMoved,
}: {
  store: Store;
  booked: Reservation;
  onMoved: (name: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const rem = remaining(store.state, booked);

  async function take(id: string, name: string) {
    setError(null);
    try {
      await checkOut(store, id, { event: booked.event });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the move");
      return;
    }
    onMoved(name);
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
          {rem.items.map((it) => (
            <li key={it.id}>
              <button className="item" type="button" onClick={() => take(it.id, displayName(store.state, it))}>
                <span className="item-name">{displayName(store.state, it)}</span>
                <span className="muted small">{homeLabel(store.state, it) || "No home"}</span>
              </button>
            </li>
          ))}
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
  const done = () => navigate(`/reservations/${booked.id}`);
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
 * The event every check-out records under, until changed or cleared (FR-OUT-05). A setting on this device.
 * A reservation's session takes it from the reservation (FR-RES-03).
 */
function SessionEvent({ store, booked }: { store: Store; booked?: Reservation }) {
  const event = store.meta.session_event;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  useUnsaved(editing && draft.trim() !== (event ?? ""), { save: () => apply().then(() => true) });

  useEffect(() => {
    if (booked && booked.event !== store.meta.session_event) void store.setMeta({ session_event: booked.event });
  }, [store, booked]);

  async function apply() {
    await store.setMeta({ session_event: draft.trim() || undefined });
    setEditing(false);
  }

  function set(e: FormEvent) {
    e.preventDefault();
    void apply();
  }

  async function clear() {
    await store.setMeta({ session_event: undefined });
    setEditing(false);
  }

  if (editing) {
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
