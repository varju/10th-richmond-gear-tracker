import type { SyncOutcome } from "../lib/sync";

interface Props {
  pending: number;
  busy: boolean;
  outcome: SyncOutcome | null;
}

/** Unsent work is shown on every screen until it is sent (FR-OFF-04). */
export function Banner({ pending, busy, outcome }: Props) {
  if (pending === 0) return null;
  const why = busy ? "sending…" : outcome?.ok === false ? outcome.reason.replace("_", " ") : "";
  return (
    <div className="banner" role="status">
      {pending} unsent {pending === 1 ? "record" : "records"}
      {why && ` · ${why}`}
    </div>
  );
}
