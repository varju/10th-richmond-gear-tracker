import { type ReactNode, useCallback, useState } from "react";
import type { Item } from "../lib/inventory";
import { addNote, checkIn, checkOut, transfer, type TransferOptions } from "../lib/movement";
import { openRepairs, raiseTicket } from "../lib/repairs";
import { type Session, sessionEvent } from "../lib/session";
import type { Store } from "../lib/store";
import { useUnsaved } from "../lib/unsaved";
import { useEventQuestion } from "./EventChoice";
import { TransferPicker } from "./TransferPicker";

/** How long a "Checked out · Tent 1" strip stays up. */
export const CONFIRM_MS = 1500;

export type MoveKind = "Checked out" | "Returned" | "Transferred";

/** A message that clears itself after `ms`. A newer message is left alone. */
export function useFlash(ms: number): [string | null, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const show = useCallback(
    (m: string) => {
      setMessage(m);
      window.setTimeout(() => setMessage((current) => (current === m ? null : current)), ms);
    },
    [ms],
  );
  return [message, show];
}

interface Props {
  store: Store;
  it: Item;
  /** Say which event a check-out records under. The scan screen already shows that at the top. */
  showEvent?: boolean;
  /** A reservation's packing session: moves record its event and link, and never ask (FR-RES-03). */
  session?: Session;
  /** `to` is set on a transfer to another member (FR-OUT-26), which does not pack a reservation. */
  onMoved: (kind: MoveKind, to?: string) => void;
  /** Offers Save without moving for a typed note or problem (FR-OUT-27), and says what was saved. */
  onSaved?: (message: string) => void;
  /** Buttons that follow the movement buttons. */
  children?: ReactNode;
}

type Pending = { kind: MoveKind; to?: string; act: (options: TransferOptions) => Promise<unknown> };

/**
 * The buttons that move an item, chosen by its state (FR-OUT-06): Check out when it is in, Return
 * when the signed-in person has it, and Return beside Take over, with neither the default, when
 * someone else has it (FR-OUT-12). Anything out can be transferred to another member (FR-OUT-26).
 * An optional note rides on the move (FR-OUT-13), and a problem raises a ticket once it has moved
 * (FR-OUT-09); either can be saved without a move (FR-OUT-27). The shell pushes the move as soon
 * as it is recorded (FR-OFF-03).
 */
export function MoveActions({ store, it, showEvent = false, session, onMoved, onSaved, children }: Props) {
  const [note, setNote] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  // A move waiting on the event question (FR-OUT-05).
  const { askThen, question } = useEventQuestion(store, session);
  // A typed note or problem goes with a move or Save without moving; leaving asks but cannot save it.
  useUnsaved((note !== null && note.trim() !== "") || (fault !== null && fault.trim() !== ""));
  const me = store.meta.user?.id;
  const { event } = session ?? sessionEvent(store.meta, store.now());
  const open = openRepairs(store.state, it.id);

  const out = it.status === "out";
  const movable = !it.retired && !it.merged_into;
  const canTake = !out && movable;
  // Someone else has it, as far as this phone knows: no default, since the record may be stale.
  const theirs = out && movable && it.holder_id !== me;

  /** Moves that record an event ask for it first, once a session (FR-OUT-05). A return never does. */
  function start(pending: Pending, recordsEvent: boolean) {
    if (recordsEvent) askThen((recorded) => void run(pending, recorded));
    else void run(pending, {});
  }

  /** `recorded` is what the event question checked when the move was made, so what was shown is what is stamped. */
  async function run({ kind, to, act }: Pending, recorded: Session) {
    setBusy(true);
    setError(null);
    const options = {
      event: recorded.event,
      // Handing gear to someone else is not packing it for the reservation (FR-RES-23).
      reservation_id: to ? undefined : recorded.reservation_id,
      note: note ?? undefined,
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
    setNote(null);
    setPicking(false);
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
        onMoved(kind, to);
        return;
      }
    }
    setBusy(false);
    onMoved(kind, to);
  }

  /** The note or problem on its own, nothing moved: a stock check from the same scan (FR-OUT-27). */
  async function saveOnly() {
    setBusy(true);
    setError(null);
    const saved: string[] = [];
    try {
      if (note?.trim()) {
        await addNote(store, it.id, note);
        setNote(null);
        saved.push("Note saved");
      }
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

  const typing = note !== null || fault !== null;
  const typed = (note?.trim() ?? "") !== "" || (fault?.trim() ?? "") !== "";

  const checkOutMove: Pending = { kind: "Checked out", act: (o) => checkOut(store, it.id, o) };
  const returnMove: Pending = { kind: "Returned", act: (o) => checkIn(store, it.id, o) };
  const takeOver: Pending = { kind: "Transferred", act: (o) => transfer(store, it.id, o) };
  const handTo = (to: string): Pending => ({
    kind: "Transferred",
    to,
    act: (o) => transfer(store, it.id, { ...o, to }),
  });

  const asking = question(children);
  if (asking) return asking;

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
      {note !== null && (
        <textarea
          aria-label="Note"
          rows={2}
          autoFocus
          placeholder="e.g. handed to a patrol leader"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      {picking ? (
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
            <button type="button" className="primary" disabled={busy} onClick={() => start(checkOutMove, true)}>
              Check out
            </button>
          )}
          {canTake && showEvent && <p className="muted small event-hint">{event ? `Event: ${event}` : "No event"}</p>}
          {out && !theirs && (
            <button type="button" className="primary" disabled={busy} onClick={() => start(returnMove, false)}>
              Return
            </button>
          )}
          {/* Equal weight, no default: this phone's record of who has it may be stale (FR-OUT-06). */}
          {theirs && (
            <div className="row moves">
              <button type="button" disabled={busy} onClick={() => start(returnMove, false)}>
                Return
              </button>
              <button type="button" disabled={busy} onClick={() => start(takeOver, true)}>
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
          {(canTake || out) && !typing && (
            <div className="row minors">
              <button type="button" className="minor" onClick={() => setNote("")}>
                Add note
              </button>
              <button type="button" className="minor" onClick={() => setFault("")}>
                Report a problem
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
    </div>
  );
}
