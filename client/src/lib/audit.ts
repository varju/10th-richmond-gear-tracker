/**
 * The audit log (FR-USR-05): what changed, from what to what, by whom.
 *
 * `changes` is one item's slice, on its detail page (FR-USR-09), read from a
 * `Log` — the server's whole record when there is signal and this device's 90
 * days when there is not (FR-INV-31, NFR-DATA-03). `entries` is the group-wide
 * screen (FR-USR-24). That one is always the server's answer, so it takes
 * events rather than a `Log`.
 */
import { categoryName, locationName, nameOf, userName } from "./inventory";
import type { Log } from "./record";
import type { ReplayEvent, State } from "./replay";

export interface Change {
  id: string;
  kind: "created" | "changed";
  /** Absent on created. */
  field?: string;
  /** "Home location", "Retired": the field as a person reads it. */
  label: string;
  old?: string;
  new?: string;
  actor_id: string;
  at: number;
}

const LABELS: Record<string, string> = {
  name: "Name",
  description: "Description",
  home_location_id: "Home location",
  // Pre-2026-09 single field; old events still show it.
  category_id: "Category",
  category_ids: "Categories",
  sub_location: "Shelf",
  generic: "Several of these",
  parent_id: "Generic",
  number: "Number",
  nickname: "Nickname",
  // Dropped as a field; events that changed it are still in the log.
  condition: "Condition",
  purchase_date: "Bought on",
  // Dropped as a field; events that changed it are still in the log.
  price: "Price",
  supplier: "Supplier",
  retired: "Retired",
  missing: "Missing",
  merged_into: "Merged into",
  deleted: "Deleted",
  // User fields. They never reach an item page; they do reach the group-wide log (FR-USR-05).
  email: "Email",
  role: "Role",
  active: "Active",
};

export const fieldLabel = (field: string): string => LABELS[field] ?? field;

/** A stored value as a person reads it: names for ids, Yes/No for flags, a dash for nothing. */
export function describeValue(state: State, field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "home_location_id") return locationName(state, String(value));
  if (field === "category_id") return categoryName(state, String(value));
  if (field === "category_ids" && Array.isArray(value)) {
    const names = value.map((id) => categoryName(state, String(id)));
    return names.length ? names.join(", ") : "—";
  }
  if (field === "parent_id" || field === "merged_into") return nameOf(state, String(value));
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (field === "price" && typeof value === "number") return `$${value.toFixed(2)}`;
  return String(value);
}

/** The item's own record changes, newest first. */
export function changes(log: Log, itemId: string): Change[] {
  const state = log.state;
  return log
    .eventsFor("item", itemId)
    .filter((e) => e.type === "created" || e.type === "field_changed")
    .map((e): Change => {
      if (e.type === "created")
        return { id: e.id, kind: "created", label: "Created", actor_id: e.actor_id, at: e.effective_at };
      const field = String(e.payload.field);
      return {
        id: e.id,
        kind: "changed",
        field,
        label: fieldLabel(field),
        old: describeValue(state, field, e.payload.old),
        new: describeValue(state, field, e.payload.value),
        actor_id: e.actor_id,
        at: e.effective_at,
      };
    })
    .reverse();
}

/** One line of the group-wide log: what happened, and what it happened to. */
export interface Entry {
  id: string;
  at: number;
  actor_id: string;
  entity_type: string;
  entity_id: string;
  /** "Checked out", "Name: Tent → Tent 1". */
  what: string;
  /** "Tent 1", "Bob", "Hall cupboard". Empty when the thing has no name of its own. */
  on: string;
}

/** Every event type but `field_changed`, which reads its own payload. */
const HAPPENED: Record<string, string> = {
  created: "Created",
  note_added: "Note added",
  note_corrected: "Note edited",
  note_deleted: "Note deleted",
  event_corrected: "Movement corrected",
  item_added: "Gear added",
  item_removed: "Gear removed",
  quantity_changed: "Quantity changed",
  checked_out: "Checked out",
  checked_in: "Checked in",
  recounted: "Recounted",
  code_bound: "Code assigned",
  code_released: "Code freed",
  photo_added: "Photo added",
  photo_removed: "Photo removed",
};

/** A count rides on a pool's movements (FR-OUT-22) and on a recount (FR-INV-35). */
function counted(label: string, payload: Record<string, unknown>): string {
  const count = payload.count;
  return typeof count === "number" ? `${label} · ${count}` : label;
}

function what(state: State, event: ReplayEvent): string {
  if (event.type === "field_changed") {
    const field = String(event.payload.field);
    const from = describeValue(state, field, event.payload.old);
    const to = describeValue(state, field, event.payload.value);
    return `${fieldLabel(field)}: ${from} → ${to}`;
  }
  // A build older than an event type still draws the row; it just cannot name it.
  const label = HAPPENED[event.type];
  return label ? counted(label, event.payload) : event.type;
}

/** What the event happened to, by name. An id is no use to someone reading a log. */
function on(state: State, event: ReplayEvent): string {
  const id = event.entity_id;
  switch (event.entity_type) {
    case "item":
      return nameOf(state, id);
    case "user":
      return userName(state, id);
    case "location":
      return locationName(state, id);
    case "category":
      return categoryName(state, id);
    case "reservation":
      return String(state.reservation?.[id]?.event ?? "");
    case "repair":
      return nameOf(state, String(state.repair?.[id]?.item_id ?? ""));
    case "found_report":
      return nameOf(state, String(state.found_report?.[id]?.item_id ?? ""));
    case "code":
      return id;
    default:
      return "";
  }
}

/** The server's answer, as lines to draw (FR-USR-24). It arrives newest first; that order is kept. */
export function entries(state: State, events: ReplayEvent[]): Entry[] {
  return events.map((e) => ({
    id: e.id,
    at: e.effective_at,
    actor_id: e.actor_id,
    entity_type: e.entity_type,
    entity_id: e.entity_id,
    what: what(state, e),
    on: on(state, e),
  }));
}

/** Every kind of event the log holds, for the filter an Admin picks from. */
export const EVENT_TYPES: { value: string; label: string }[] = [
  ...Object.entries(HAPPENED).map(([value, label]) => ({ value, label })),
  { value: "field_changed", label: "Edited" },
].sort((a, b) => a.label.localeCompare(b.label));
