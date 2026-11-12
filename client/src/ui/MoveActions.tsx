import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Item } from "../lib/inventory";
import type { Weight } from "../lib/weighing";
import { backFromCleaning, checkIn, checkOut, sendItemHome, transfer, type TransferOptions } from "../lib/movement";
import { openRepairs, raiseTicket } from "../lib/repairs";
import { type Session, sessionEvent } from "../lib/session";
import type { Store } from "../lib/store";
import { useUnsaved } from "../lib/unsaved";
import { keepLabel, weighing } from "../lib/weighing";
import { CleanerField } from "./CleanerField";
import { TransferPicker } from "./TransferPicker";
import { WeighEntry, weighHint } from "./Weighing";

/** How long the move buttons and the "Saved" strip hold after a tap. */
export const CONFIRM_MS = 1500;

/** How long a "Checked out · Tent 1" strip stays up. */
export const MOVED_MS = 4000;

export type MoveKind = "Checked out" | "Returned" | "Transferred" | "Sent home" | "Back from home";

/** What a confirmation says: who the gear went home with, or came back from, when a name is given. */
export function movedText(kind: MoveKind, cleaner?: string): string {
  if (!cleaner) return kind;
  return kind === "Back from home" ? `Back from ${cleaner}` : `Sent home with ${cleaner}`;
}

/** A message that clears itself after `ms`. A newer message restarts the time. */
export function useFlash(ms: number): [string | null, (message: string) => void, () => void] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    setMessage(null);
  }, []);
  const show = useCallback(
    (m: string) => {
      window.clearTimeout(timer.current);
      setMessage(m);
      timer.current = window.setTimeout(() => setMessage(null), ms);
    },
    [ms],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [message, show, clear];
}

interface Props {
  store: Store;
  it: Item;
  /** Say which event a check-out records under. The scan screen already shows that at the top. */
  showEvent?: boolean;
  /** A reservation's packing session: moves record its event and link, and never ask (FR-RES-03). */
  session?: Session;
  /** `to` is set on a transfer to another member (FR-OUT-26), which does not pack a reservation. `cleaner` names who took it home. */
  onMoved: (kind: MoveKind, to?: string, cleaner?: string) => void;
  /** Offers Save without moving for a typed problem (FR-OUT-27), and says what was saved. */
  onSaved?: (message: string) => void;
  /** Offers the Report a problem toggle. The item page has its own, under Repairs. */
  reportProblem?: boolean;
  /** Buttons that follow the movement buttons. */
  children?: ReactNode;
  /** Shown after the children, only while no question, picker or move is under way. */
  whenIdle?: ReactNode;
}

type Pending = { kind: MoveKind; to?: string; cleaner?: string; act: (options: TransferOptions) => Promise<unknown> };

/**
 * The buttons that move an item, chosen by its state (FR-OUT-06): Check out when it is in, Return
 * when the signed-in person has it, and Return beside Take over, with neither the default, when
 * someone else has it (FR-OUT-12). Anything out can be transferred to another member (FR-OUT-26).
 * A problem raises a ticket once it has moved (FR-OUT-09), or is saved without a move (FR-OUT-27). The shell pushes the move as soon
 * as it is recorded (FR-OFF-03).
 */
export function MoveActions({
  store,
  it,
  showEvent = false,
  session,
  onMoved,
  onSaved,
  reportProblem = false,
  children,
  whenIdle,
}: Props) {
  const [fault, setFault] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justMoved, settle] = useFlash(CONFIRM_MS);
  const [picking, setPicking] = useState(false);
  // Weighed gear asks what it weighs as it comes back (FR-INV-67).
  const [weighing_, setWeighing] = useState(false);
  // The name being typed for gear sent home with someone (FR-OUT-46); null when not asking.
  const [cleaner, setCleaner] = useState<string | null>(null);
  // A typed problem goes with a move or Save without moving; leaving asks but cannot save it.
  useUnsaved((fault !== null && fault.trim() !== "") || (cleaner !== null && cleaner.trim() !== ""));
  const me = store.meta.user?.id;
  const { event, waits } = session ?? sessionEvent(store.meta, store.now());
  const open = openRepairs(store.state, it.id);

  const out = it.status === "out";
  const movable = !it.retired && !it.merged_into;
  const canTake = !out && movable;
  // Someone else has it, as far as this phone knows: no default, since the record may be stale.
  const theirs = out && movable && it.holder_id !== me;

  /**
   * Moves that record an event take the session's, read when the move is made (FR-OUT-05); before it
   * is answered they move at once and wait for it. A return records none.
   */
  function start(pending: Pending, recordsEvent: boolean) {
    void run(pending, recordsEvent ? session ?? sessionEvent(store.meta, store.now()) : {});
  }

  async function run({ kind, to, cleaner: cleanerName, act }: Pending, recorded: Session) {
    setBusy(true);
    setError(null);
    const options = {
      event: recorded.event,
      waits: recorded.waits,
      // Handing gear to someone else is not packing it for the reservation (FR-RES-23).
      reservation_id: to ? undefined : recorded.reservation_id,
      // Packing has its own fixed session and leaves the plain one alone (FR-RES-25).
      packing: session !== undefined,
    };
    try {
      await act(options);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the move");
      setBusy(false);
      return;
    }
    setPicking(false);
    setCleaner(null);
    // The move already happened; a fault that fails to record is a separate problem and must not
    // read as the move itself failing, nor risk the move being repeated on a retry. The fault text
    // stays so the person can try raising it again.
    if (fault?.trim()) {
      try {
        await raiseTicket(store, it.id, fault);
        setFault(null);
      } catch (e) {
        setError(`Moved, but the problem was not recorded: ${e instanceof Error ? e.message : "unknown error"}`);
        setBusy(false);
        settle(kind);
        onMoved(kind, to, cleanerName);
        return;
      }
    }
    setBusy(false);
    settle(kind);
    onMoved(kind, to, cleanerName);
  }

  /** The problem on its own, nothing moved: a stock check from the same scan (FR-OUT-27). */
  async function saveOnly() {
    setBusy(true);
    setError(null);
    const saved: string[] = [];
    try {
      if (fault?.trim()) {
        await raiseTicket(store, it.id, fault);
        setFault(null);
        saved.push("Problem reported");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save it");
      setBusy(false);
      return;
    }
    setBusy(false);
    if (saved.length > 0) onSaved?.(saved.join(", "));
  }

  // Buttons shift under the finger, so a second tap would record the opposite move.
  const holding = busy || justMoved !== null;
  const typing = fault !== null;
  const typed = (fault?.trim() ?? "") !== "";

  const checkOutMove: Pending = { kind: "Checked out", act: (o) => checkOut(store, it.id, o) };
  const returnMove: Pending = { kind: "Returned", act: (o) => checkIn(store, it.id, o) };
  const w = weighing(store.state, it);
  useEffect(() => {
    if (!w) setWeighing(false);
  }, [w]);
  const returnWeighed = (answer: { weight: Weight | null } | { keep: true }): Pending => ({
    kind: "Returned",
    act: (o) => checkIn(store, it.id, { ...o, ...answer }),
  });
  /** The Return button: weighed gear always asks its weight first (FR-INV-67). */
  const startReturn = () => (w ? setWeighing(true) : start(returnMove, false));
  const backMove: Pending = {
    kind: "Back from home",
    cleaner: it.movement?.cleaner,
    act: () => backFromCleaning(store, it.id),
  };
  const takeOver: Pending = { kind: "Transferred", act: (o) => transfer(store, it.id, o) };
  const handTo = (to: string): Pending => ({
    kind: "Transferred",
    to,
    act: (o) => transfer(store, it.id, { ...o, to }),
  });

  const sendHome = (name: string): Pending => ({
    kind: "Sent home",
    cleaner: name,
    act: (o) => sendItemHome(store, it.id, { packing: o.packing, cleaner: name }),
  });

  return (
    <div className="move-actions">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {it.retired && (
        <p className="notice" role="note">
          Retired. Cannot be checked out.
        </p>
      )}
      {open.length > 0 && (
        // Warn, never block (FR-REP-05, FR-RES-08).
        <p className="notice" role="note">
          Needs repair · {open[0]!.description}
          {open.length > 1 && ` · ${open.length - 1} more`}
        </p>
      )}
      {fault !== null && (
        <textarea
          aria-label="Problem"
          rows={2}
          autoFocus
          placeholder="e.g. zipper broken on the bag"
          value={fault}
          onChange={(e) => setFault(e.target.value)}
        />
      )}
      {cleaner !== null ? (
        <section className="cleaner-picker" aria-label="Send home with">
          <CleanerField store={store} value={cleaner} onChange={setCleaner} disabled={busy} />
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy || cleaner.trim() === ""}
              onClick={() => start(sendHome(cleaner.trim()), false)}
            >
              Send home
            </button>
            <button type="button" onClick={() => setCleaner(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : weighing_ && w ? (
        <WeighEntry
          unit={w.unit}
          submitLabel="Return"
          hint={weighHint(store, it)}
          busy={busy}
          onSubmit={(weight) => {
            setWeighing(false);
            start(returnWeighed({ weight }), false);
          }}
          onUnknown={() => {
            setWeighing(false);
            start(returnWeighed({ weight: null }), false);
          }}
          keepLabel={keepLabel(store.state, it)}
          onKeep={() => {
            setWeighing(false);
            start(returnWeighed({ keep: true }), false);
          }}
          onCancel={() => setWeighing(false)}
        />
      ) : picking ? (
        <TransferPicker
          store={store}
          it={it}
          busy={busy}
          onPick={(to) => start(handTo(to), true)}
          onCancel={() => setPicking(false)}
        />
      ) : (
        <>
          {canTake && (
            <button type="button" className="primary" disabled={holding} onClick={() => start(checkOutMove, true)}>
              Check out
            </button>
          )}
          {canTake && showEvent && !waits && (
            <p className="muted small event-hint">{event ? `Event: ${event}` : "No event"}</p>
          )}
          {out && movable && it.movement?.cleaner && (
            <button type="button" className="primary" disabled={holding} onClick={() => start(backMove, false)}>
              Back from {it.movement.cleaner}
            </button>
          )}
          {out && !theirs && (
            <button
              type="button"
              className={it.movement?.cleaner ? undefined : "primary"}
              disabled={holding}
              onClick={startReturn}
            >
              Return
            </button>
          )}
          {/* Equal weight, no default: this phone's record of who has it may be stale (FR-OUT-06). */}
          {theirs && (
            <div className="row moves">
              <button type="button" disabled={holding} onClick={startReturn}>
                Return
              </button>
              <button type="button" disabled={holding} onClick={() => start(takeOver, true)}>
                Take over
              </button>
            </div>
          )}
          {onSaved && typed && (
            <button type="button" disabled={busy} onClick={() => void saveOnly()}>
              Save without moving
            </button>
          )}
          {/* The minor toggles sit in rows of their own, so a row's buttons share one height. */}
          {reportProblem && (canTake || out) && !typing && (
            <div className="row minors">
              <button type="button" className="minor" onClick={() => setFault("")}>
                Report a problem
              </button>
            </div>
          )}
          {out && movable && !it.movement?.cleaner && session === undefined && !typing && (
            <div className="row minors">
              <button type="button" className="minor" disabled={busy} onClick={() => setCleaner("")}>
                Send home with…
              </button>
            </div>
          )}
          {out && movable && (
            <div className="row minors">
              <button type="button" className="minor" disabled={busy} onClick={() => setPicking(true)}>
                Transfer to…
              </button>
            </div>
          )}
        </>
      )}
      {children}
      {cleaner === null && !(weighing_ && w) && !picking && !holding && whenIdle}
    </div>
  );
}
