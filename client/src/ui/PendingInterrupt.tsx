import { ago } from "../lib/time";

interface Props {
  count: number;
  oldest: number;
  now: number;
  busy: boolean;
  onSync: () => void;
  onContinue: () => void;
}

/** Work pending more than 3 days stops the show on open (FR-OFF-09). */
export function PendingInterrupt({ count, oldest, now, busy, onSync, onContinue }: Props) {
  return (
    <div className="interrupt" role="alertdialog" aria-labelledby="interrupt-title">
      <h2 id="interrupt-title">
        {count} {count === 1 ? "record has" : "records have"} been waiting {ago(now - oldest)}
      </h2>
      <p>They are only on this device. Get a connection and sync before this device is lost, reset, or cleaned up.</p>
      <div className="actions">
        <button className="primary" onClick={onSync} disabled={busy}>
          Sync now
        </button>
        <button onClick={onContinue}>Continue anyway</button>
      </div>
    </div>
  );
}
