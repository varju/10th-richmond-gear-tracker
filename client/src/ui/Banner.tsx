import { useEffect, useState } from "react";
import type { StoredEvent } from "../lib/store";
import { leave } from "../lib/unsaved";
import type { SyncOutcome } from "../lib/sync";
import { plural } from "./labels";

/** A record this young is on its way; showing it as unsent would flash on every save. */
export const GRACE_MS = 5_000;

interface Props {
  pending: StoredEvent[];
  busy: boolean;
  outcome: SyncOutcome | null;
  now: () => number;
  /** False while a dialog covers the page: the link would lead behind it. */
  linked?: boolean;
}

/**
 * Unsent work is shown on every screen until it is sent (FR-OFF-04). Records
 * are pushed the moment they exist, so the banner waits a few seconds before
 * calling one unsent, unless the last sync already failed.
 */
export function Banner({ pending, busy, outcome, now, linked = true }: Props) {
  const oldest = Math.min(...pending.map((e) => e.occurred_at));
  const graceUntil = oldest + GRACE_MS;
  const hidden = pending.length > 0 && outcome?.ok !== false && now() < graceUntil;

  // Come back when the grace runs out, even if nothing else re-renders.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!hidden) return;
    const t = setTimeout(() => tick((n) => n + 1), graceUntil - now());
    return () => clearTimeout(t);
  }, [hidden, graceUntil, now]);

  if (pending.length === 0 || hidden) return null;
  const why = busy ? "sending…" : outcome?.ok === false ? outcome.reason.replace("_", " ") : "";
  const text = `${plural(pending.length, "unsent record")}${why && ` · ${why}`}`;
  return (
    <div className="banner" role="status">
      {linked ? (
        <button className="link" type="button" onClick={() => leave("/settings/unsent")}>
          {text}
        </button>
      ) : (
        text
      )}
    </div>
  );
}
