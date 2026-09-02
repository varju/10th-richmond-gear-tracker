import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { bindCode } from "../lib/actions";
import { parseCode } from "../lib/codes";
import { code as codeOf, codeStatus, homeLabel, item } from "../lib/inventory";
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
 * and is bound here (FR-TAG-04).
 */
export function Scan({ store }: { store: Store }) {
  useStore(store);
  const forItem = useRoute().query.get("for");
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
        return showCard(codeOf(store.state, id)?.item_id ?? null);
      }
      if (status !== "unassigned") {
        const owner = item(store.state, codeOf(store.state, id)?.item_id ?? "");
        return say(`That code is already on ${owner?.name ?? "another item"}`);
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
      title={forItem ? "Scan new code" : "Scan"}
      back={forItem ? `/items/${forItem}` : "/"}
      actions={
        card ? undefined : (
          <>
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
      {!forItem && <SessionEvent store={store} />}
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
            <h2 id="move-card-title">{card.name}</h2>
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
                confirm(`${kind} · ${card.name}`);
                showCard(null);
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
    </Page>
  );
}

/** The event every check-out records under, until changed or cleared (FR-OUT-05). A setting on this device. */
function SessionEvent({ store }: { store: Store }) {
  const event = store.meta.session_event;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  useUnsaved(editing && draft.trim() !== (event ?? ""), { save: () => apply().then(() => true) });

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
