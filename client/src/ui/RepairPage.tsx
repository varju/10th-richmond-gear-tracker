import { useState } from "react";
import { nameOf } from "../lib/inventory";
import { REPAIR_STATES, canDelete, deleteTicket, repair, setRepairState, stateLabel } from "../lib/repairs";
import type { Note } from "../lib/replay";
import { back, navigate } from "../lib/router";
import type { Store } from "../lib/store";
import { localMinute } from "../lib/time";
import { guard } from "../lib/unsaved";
import { useStore } from "../useStore";
import { ConfirmButton } from "./ConfirmButton";
import { userName } from "./labels";
import { AddNote, NoteList } from "./Notes";
import { Page } from "./Page";
import { Photos } from "./Photos";

interface Props {
  store: Store;
  id: string;
}

/** One ticket: what is wrong, where it stands, and the comments that carry the repair (FR-REP-03, FR-REP-06). */
export function RepairPage({ store, id }: Props) {
  useStore(store);
  const [error, setError] = useState<string | null>(null);
  const state = store.state;
  const ticket = repair(state, id);

  if (!ticket) {
    return (
      <Page title="Not found" back="/repairs">
        <p>No ticket with that id. It may not have synced to this device yet.</p>
      </Page>
    );
  }

  if (ticket.deleted) {
    return (
      <Page title="Repair" back={`/items/${ticket.item_id}`}>
        <p className="notice" role="note">
          This ticket was deleted.
        </p>
      </Page>
    );
  }

  const raisedBy = state.repair?.[id] ? raisedByLabel(store, id) : "";

  async function move(to: (typeof REPAIR_STATES)[number]["value"]) {
    setError(null);
    try {
      await setRepairState(store, id, to);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the state");
    }
  }

  return (
    <Page
      title="Repair"
      back={`/items/${ticket.item_id}`}
      actions={
        <>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {REPAIR_STATES.filter((s) => s.value !== ticket.state).map((s) => (
            <button key={s.value} type="button" onClick={() => move(s.value)}>
              {s.label}
            </button>
          ))}
        </>
      }
    >
      <button className="link" type="button" onClick={() => guard(() => navigate(`/items/${ticket.item_id}`))}>
        {nameOf(store.state, ticket.item_id)}
      </button>
      <p className="repair-state">{stateLabel(ticket.state)}</p>
      <p className="prose">{ticket.description}</p>
      <p className="muted small">{raisedBy}</p>

      <h3 className="section">Photos</h3>
      <Photos store={store} on={{ entity_type: "repair", entity_id: id }} />

      <h3 className="section">Comments</h3>
      <NoteList store={store} on={{ entity_type: "repair", entity_id: id }} notes={(ticket.notes ?? []) as Note[]} />
      <AddNote store={store} on={{ entity_type: "repair", entity_id: id }} />

      <DeleteTicket store={store} id={id} itemId={ticket.item_id} onError={setError} />
    </Page>
  );
}

/** Two taps, because there is no undo (FR-REP-10). Moving away cancels the first. */
function DeleteTicket({
  store,
  id,
  itemId,
  onError,
}: {
  store: Store;
  id: string;
  itemId: string;
  onError: (message: string) => void;
}) {
  if (!canDelete(store, id)) return null;

  async function remove() {
    try {
      await deleteTicket(store, id);
      back(`/items/${itemId}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not delete the ticket");
    }
  }

  return (
    <ConfirmButton label="Delete ticket…" confirmLabel="Really delete? This cannot be undone" onConfirm={remove} />
  );
}

/** "Raised by Alice · 2026-09-01 14:32". Who raised it is a field on the ticket; the created
 * event is a fallback for a ticket recorded before that field existed. */
function raisedByLabel(store: Store, id: string): string {
  const ticket = repair(store.state, id);
  const when = ticket?.added_at ? localMinute(ticket.added_at) : "";
  const raisedById = ticket?.raised_by ?? store.eventsFor("repair", id).find((e) => e.type === "created")?.actor_id;
  const who = raisedById ? userName(store.state, raisedById) : "";
  return [who ? `Raised by ${who}` : "Raised", when].filter(Boolean).join(" · ");
}
