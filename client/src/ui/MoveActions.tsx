import { type ReactNode, useCallback, useState } from "react";
import type { Item } from "../lib/inventory";
import { checkIn, checkOut, transfer } from "../lib/movement";
import type { Store } from "../lib/store";
import { useUnsaved } from "../lib/unsaved";

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
  onMoved: (kind: MoveKind) => void;
  /** Buttons that follow the movement buttons. */
  children?: ReactNode;
}

/**
 * The buttons that move an item, chosen by its state (FR-OUT-06, FR-OUT-12),
 * with an optional note on the movement (FR-OUT-13). The shell pushes the
 * move as soon as it is recorded (FR-OFF-03).
 */
export function MoveActions({ store, it, showEvent = false, onMoved, children }: Props) {
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A typed note only makes sense with a move, so leaving asks but cannot save it.
  useUnsaved(note !== null && note.trim() !== "");
  const me = store.meta.user?.id;
  const event = store.meta.session_event;

  const out = it.status === "out";
  const canTake = !out && !it.retired;
  const canTransfer = out && !it.retired && it.holder_id !== me;

  async function run(kind: MoveKind, act: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await act();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the move");
      return;
    } finally {
      setBusy(false);
    }
    setNote(null);
    onMoved(kind);
  }

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
      {canTake && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => run("Checked out", () => checkOut(store, it.id, options))}
        >
          Check out
        </button>
      )}
      {canTake && showEvent && <p className="muted small event-hint">{event ? `Event: ${event}` : "No event"}</p>}
      {out && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => run("Checked in", () => checkIn(store, it.id, options))}
        >
          Check in
        </button>
      )}
      {(canTransfer || ((canTake || out) && note === null)) && (
        <div className="row">
          {canTransfer && (
            <button
              type="button"
              disabled={busy}
              onClick={() => run("Transferred", () => transfer(store, it.id, options))}
            >
              Transfer to me
            </button>
          )}
          {(canTake || out) && note === null && (
            <button type="button" className="minor" onClick={() => setNote("")}>
              Add note
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
