import { type FormEvent, useEffect, useRef, useState } from "react";
import { seen } from "../lib/actions";
import { parseCode } from "../lib/codes";
import {
  code as codeOf,
  codeStatus,
  displayName,
  homeLabel,
  type Item,
  item,
  locations,
  subLocations,
} from "../lib/inventory";
import { navigate } from "../lib/router";
import { confirmRead, READ_MS, startScanner, unlockSound } from "../lib/scanner";
import {
  atHome,
  misplaced,
  notSeen,
  seenHere,
  startCheck,
  type StockCheck as Check,
  withSeen,
} from "../lib/stockcheck";
import type { Store } from "../lib/store";
import { useShell } from "../shell";
import { useStore } from "../useStore";
import { useFlash } from "./MoveActions";
import { Page } from "./Page";

const FLASH_MS = 2000;

/**
 * Walk one location and scan what is there (FR-RPT-09). The person picks where
 * they are; each scan is a sighting. Misplaced gear and gear not seen show as
 * the walk goes, and again at the end. The session is a device setting, so a
 * closed app comes back to the same shelf.
 */
export function StockCheck({ store }: { store: Store }) {
  useStore(store);
  const check = store.meta.stock_check;
  if (!check) return <Start store={store} />;
  return <Walk store={store} check={check} />;
}

function Start({ store }: { store: Store }) {
  const { now } = useShell();
  const state = store.state;
  const [locationId, setLocationId] = useState("");
  const [sub, setSub] = useState("");
  const all = locations(state).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Page
      title="Stock check"
      back="/"
      actions={
        <button
          className="primary"
          type="button"
          disabled={!locationId}
          onClick={() => store.setMeta({ stock_check: startCheck(locationId, sub, now()) })}
        >
          Start
        </button>
      }
    >
      <p>
        A stock check compares one shelf with the records: what is misplaced here, and what should be here but was not
        seen.
      </p>
      <p>Where are you standing? Then scan everything on the shelf.</p>
      <label>
        <span>Location</span>
        <select
          value={locationId}
          onChange={(e) => {
            setLocationId(e.target.value);
            setSub("");
          }}
        >
          <option value="">Choose</option>
          {all.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Shelf</span>
        <select value={sub} onChange={(e) => setSub(e.target.value)} disabled={!locationId}>
          <option value="">Whole location</option>
          {subLocations(state, locationId || undefined).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
    </Page>
  );
}

function Walk({ store, check }: { store: Store; check: Check }) {
  const state = store.state;
  const video = useRef<HTMLVideoElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const [flash, say] = useFlash(FLASH_MS);
  const [read, flashRead] = useFlash(READ_MS);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [finishing, setFinishing] = useState(false);
  const where = [state.location?.[check.location_id]?.name as string | undefined, check.sub_location]
    .filter(Boolean)
    .join(" / ");

  async function handle(text: string) {
    const id = parseCode(text);
    if (!id) return say("Not a gear code");
    const status = codeStatus(state, id);
    if (status === "unknown") return say("Not one of our codes");
    confirmRead();
    flashRead("read");
    if (status === "unassigned") return say("Not on anything yet");
    const itemId = codeOf(state, id)?.item_id;
    const it = itemId ? item(state, itemId) : undefined;
    if (!itemId || !it) return say("Not one of our codes");
    await sighted(it);
  }

  /** A sighting, by scan or by tap: the item is here, and the walk moves on (FR-INV-19). */
  async function sighted(it: Item) {
    await seen(store, it.id);
    await store.setMeta({ stock_check: withSeen(store.meta.stock_check ?? check, it.id) });
    const home = homeLabel(state, it);
    const label = displayName(state, it);
    say(atHome(it, check) ? `Seen · ${label}` : `Misplaced · ${label} · ${home ? `home ${home}` : "no home"}`);
  }

  const latest = useRef(handle);
  latest.current = handle;

  useEffect(() => {
    unlockSound();
    document.addEventListener("pointerdown", unlockSound);
    return () => document.removeEventListener("pointerdown", unlockSound);
  }, []);

  useEffect(() => {
    if (!video.current || finishing) return;
    const scanner = startScanner(video.current, (text) => void latest.current(text), {
      target: () => target.current,
      onError: setCameraError,
    });
    return () => scanner.stop();
  }, [finishing]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = typed;
    setTyped("");
    void handle(text);
  }

  async function done() {
    await store.setMeta({ stock_check: undefined });
    navigate("/", true);
  }

  const away = misplaced(state, check);
  const left = notSeen(state, check);
  const here = seenHere(state, check);

  if (finishing) {
    return (
      <Page
        title="Stock check"
        back="/"
        actions={
          <>
            <button className="primary" type="button" onClick={done}>
              Done
            </button>
            <button type="button" onClick={() => setFinishing(false)}>
              Keep going
            </button>
          </>
        }
      >
        <p className="muted small">
          {where} · {here.length} in place
        </p>
        <Lists store={store} misplaced={away} notSeen={left} onSeen={(it) => void sighted(it)} />
      </Page>
    );
  }

  return (
    <Page
      title="Stock check"
      back="/"
      actions={
        <>
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
          <button type="button" onClick={() => setFinishing(true)}>
            Finish
          </button>
        </>
      }
    >
      <p className="muted small">
        {where} · {here.length} in place
      </p>
      <div className={read ? "viewfinder read" : "viewfinder"}>
        <video ref={video} muted playsInline hidden={cameraError !== null} />
        {!cameraError && <div ref={target} className="target" aria-hidden="true" />}
        {cameraError ? (
          <p className="scan-error" role="alert">
            {cameraError}
          </p>
        ) : (
          <p className="scan-hint">Scan everything on the shelf</p>
        )}
        {flash && (
          <p className="scan-flash" role="status">
            {flash}
          </p>
        )}
      </div>
      <Lists store={store} misplaced={away} notSeen={left} onSeen={(it) => void sighted(it)} />
    </Page>
  );
}

interface ListsProps {
  store: Store;
  misplaced: Item[];
  notSeen: Item[];
  /** Tapped instead of scanned: no code on it, or the sticker is somewhere awkward. */
  onSeen: (it: Item) => void;
}

function Lists({ store, misplaced, notSeen, onSeen }: ListsProps) {
  const state = store.state;
  return (
    <>
      <section aria-label="Misplaced here">
        <h2 className="section">Misplaced here · {misplaced.length}</h2>
        {misplaced.length === 0 ? (
          <p className="muted">Nothing out of place.</p>
        ) : (
          <ul className="items">
            {misplaced.map((it) => (
              <li key={it.id}>
                <button className="item" type="button" onClick={() => navigate(`/items/${it.id}`)}>
                  <span className="item-name">{displayName(state, it)}</span>
                  <span className="muted small">
                    {homeLabel(state, it) ? `Home: ${homeLabel(state, it)}` : "No home"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Not seen yet">
        <h2 className="section">Not seen yet · {notSeen.length}</h2>
        {notSeen.length === 0 ? (
          <p className="muted">Everything that belongs here has been seen.</p>
        ) : (
          <ul className="items">
            {notSeen.map((it) => (
              <li key={it.id} className="row">
                <button className="item" type="button" onClick={() => navigate(`/items/${it.id}`)}>
                  <span className="item-name">{displayName(state, it)}</span>
                  <span className="muted small">{homeLabel(state, it)}</span>
                </button>
                <button
                  className="small"
                  type="button"
                  onClick={() => onSeen(it)}
                  aria-label={`Seen: ${displayName(state, it)}`}
                >
                  Seen
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
