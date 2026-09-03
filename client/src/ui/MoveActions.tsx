import { type ReactNode, useCallback, useState } from "react";
import type { Item } from "../lib/inventory";
import { checkIn, checkOut, transfer } from "../lib/movement";
import { openRepairs, raiseTicket } from "../lib/repairs";
import type { Store } from "../lib/store";
import { useUnsaved } from "../lib/unsaved";
import { userName } from "./labels";

/** How long a "Checked out · Tent 1" strip stays up. */
export const CONFIRM_MS = 1500;

export type MoveKind = "Checked out" | "Checked in" | "Transferred";

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
  /**
   * Which move the session expects. A scan that agrees offers one plain
   * button, as before; one that disagrees warns and demotes that button to a
   * secondary one, next to whichever move does agree (FR-OUT-12). Null (the
   * default) is today's behaviour, used from the item page.
   */
  mode?: "out" | "in" | null;
  onMoved: (kind: MoveKind) => void;
  /** Buttons that follow the movement buttons. */
  children?: ReactNode;
}

/**
 * The buttons that move an item, chosen by its state (FR-OUT-06, FR-OUT-12),
 * with an optional note on the movement (FR-OUT-13) or a problem to raise a
 * ticket for once it has moved (FR-OUT-09). The shell pushes the move as soon
 * as it is recorded (FR-OFF-03).
 */
export function MoveActions({ store, it, showEvent = false, mode = null, onMoved, children }: Props) {
  const [note, setNote] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A typed note or problem only makes sense with a move, so leaving asks but cannot save it.
  useUnsaved((note !== null && note.trim() !== "") || (fault !== null && fault.trim() !== ""));
  const me = store.meta.user?.id;
  const event = store.meta.session_event;
  const open = openRepairs(store.state, it.id);

  const out = it.status === "out";
  const canTake = !out && !it.retired && !it.merged_into;
  const canTransfer = out && !it.retired && !it.merged_into && it.holder_id !== me;
  // Out when the session wants it taken out, or wanted back when it is already in: nothing to do but warn.
  const outDisagrees = mode === "out" && out && !it.retired && !it.merged_into;
  const inDisagrees = mode === "in" && canTake;

  async function run(kind: MoveKind, act: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await act();
      if (fault?.trim()) await raiseTicket(store, it.id, fault);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the move");
      return;
    } finally {
      setBusy(false);
    }
    setNote(null);
    setFault(null);
    onMoved(kind);
  }

  const typing = note !== null || fault !== null;

  const options = { event, note: note ?? undefined };

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
      {outDisagrees && (
        <p className="notice" role="note">
          {it.holder_id === me ? "Already out to you." : `Already out. ${userName(store.state, it.holder_id)} has it.`}
        </p>
      )}
      {inDisagrees && (
        <p className="notice" role="note">
          Already in. Nothing to do.
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
      {canTake && !inDisagrees && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => run("Checked out", () => checkOut(store, it.id, options))}
        >
          Check out
        </button>
      )}
      {canTake && !inDisagrees && showEvent && (
        <p className="muted small event-hint">{event ? `Event: ${event}` : "No event"}</p>
      )}
      {out && !outDisagrees && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => run("Checked in", () => checkIn(store, it.id, options))}
        >
          Check in
        </button>
      )}
      {(canTransfer || outDisagrees || inDisagrees || ((canTake || out) && !typing)) && (
        <div className="row">
          {canTransfer && (
            <button
              type="button"
              className={outDisagrees ? "primary" : undefined}
              disabled={busy}
              onClick={() => run("Transferred", () => transfer(store, it.id, options))}
            >
              Transfer to me
            </button>
          )}
          {outDisagrees && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run("Checked in", () => checkIn(store, it.id, options))}
            >
              Check in
            </button>
          )}
          {inDisagrees && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run("Checked out", () => checkOut(store, it.id, options))}
            >
              Check out
            </button>
          )}
          {(canTake || out) && !typing && (
            <>
              <button type="button" className="minor" onClick={() => setNote("")}>
                Add note
              </button>
              <button type="button" className="minor" onClick={() => setFault("")}>
                Report a problem
              </button>
            </>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
