/**
 * Replay: events in, current state out. Pure.
 *
 * This runs twice, here and in Python on the server (src/gear_tracker/replay.py),
 * and the two must agree. The shared vectors under vectors/replay/ are the
 * contract (NFR-MAINT-04). Change a rule here, change the vectors, and the other
 * side fails until it catches up.
 */

export type Fields = Record<string, unknown>;
/** entity_type -> entity_id -> fields */
export type State = Record<string, Record<string, Fields>>;

export interface ReplayEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  type: string;
  actor_id: string;
  device_id: string;
  device_seq: number;
  effective_at: number;
  payload: Record<string, unknown>;
}

export interface Note {
  id: string;
  text: string;
  actor_id: string;
  at: number;
  movement_id?: string;
}

export interface Movement {
  id: string;
  type: string;
  holder_id: unknown;
  event: unknown;
  actor_id: string;
  device_id: string;
  at: number;
}

export class UnknownEventType extends Error {}

/** (effective_at, device_id, device_seq): the one order every replay uses. */
export function replayOrder(a: ReplayEvent, b: ReplayEvent): number {
  if (a.effective_at !== b.effective_at) return a.effective_at - b.effective_at;
  if (a.device_id !== b.device_id) return a.device_id < b.device_id ? -1 : 1;
  return a.device_seq - b.device_seq;
}

/**
 * Build state, from scratch or on top of a snapshot. Input order does not
 * matter; replay order does. The base is not changed.
 */
export function replay(events: Iterable<ReplayEvent>, base?: State): State {
  const state: State = base ? structuredClone(base) : {};
  for (const event of [...events].sort(replayOrder)) {
    const entities = (state[event.entity_type] ??= {});
    const entity = (entities[event.entity_id] ??= {});
    apply(entity, event);
  }
  return state;
}

/** One event onto one entity's fields, in place. */
export function apply(entity: Fields, event: ReplayEvent): void {
  const p = event.payload;
  switch (event.type) {
    case "created":
      Object.assign(entity, p);
      entity.added_at = event.effective_at;
      entity.modified_at = event.effective_at;
      if (event.entity_type === "item") {
        if (!("status" in entity)) entity.status = "in";
        if (!("holder_id" in entity)) entity.holder_id = null;
      }
      break;
    case "field_changed":
      // Modified means the entity's own fields (FR-INV-03). Movements and notes do not count.
      entity[p.field as string] = p.value;
      entity.modified_at = event.effective_at;
      break;
    case "note_added": {
      const note: Note = { id: event.id, text: p.text as string, actor_id: event.actor_id, at: event.effective_at };
      if (p.movement_id != null) note.movement_id = p.movement_id as string;
      notes(entity).push(note);
      break;
    }
    case "note_corrected":
      // The original event stands in the log; only the rendered text moves.
      for (const note of notes(entity)) {
        if (note.id === p.note_id) note.text = p.text as string;
      }
      break;
    case "checked_out": {
      // Two check-outs from different devices with no check-in between:
      // the machine picks the later one and queues both (FR-OFF-10).
      // Unless the later one says which check-out it replaces: that is a
      // transfer, made by someone who saw the first (FR-OUT-12).
      const previous = entity.movement as Movement | null | undefined;
      if (
        previous &&
        previous.type === "checked_out" &&
        previous.device_id !== event.device_id &&
        p.supersedes !== previous.id
      ) {
        ((entity.conflicts ??= []) as unknown[]).push({
          kind: "double_checkout",
          events: [previous, movement(event)],
        });
      }
      entity.status = "out";
      entity.holder_id = p.holder_id;
      entity.since = event.effective_at;
      entity.movement = movement(event);
      break;
    }
    case "checked_in":
      entity.status = "in";
      entity.holder_id = null;
      entity.since = event.effective_at;
      entity.movement = movement(event);
      break;
    case "code_bound":
      // A code binds once. Whether it is the item's current code or a replaced
      // one is a question about the item's other codes, answered by whoever asks.
      entity.item_id = p.item_id;
      entity.bound_at = event.effective_at;
      break;
    default:
      throw new UnknownEventType(event.type);
  }
}

function notes(entity: Fields): Note[] {
  return (entity.notes ??= []) as Note[];
}

function movement(event: ReplayEvent): Movement {
  return {
    id: event.id,
    type: event.type,
    holder_id: event.payload.holder_id ?? null,
    event: event.payload.event ?? null,
    actor_id: event.actor_id,
    device_id: event.device_id,
    at: event.effective_at,
  };
}
