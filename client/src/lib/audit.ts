/**
 * An item's audit history (FR-USR-09): what changed on the record, from what to
 * what, by whom. Read from the events this phone holds, so it reaches back 90
 * days (NFR-DATA-03). Movements are the History section; this is the rest.
 */
import { locationName, nameOf } from "./inventory";
import type { State } from "./replay";
import type { Store } from "./store";

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
  sub_location: "Sub-location",
  generic: "Several of these",
  parent_id: "Generic",
  number: "Number",
  nickname: "Nickname",
  // Dropped as a field; events that changed it are still in the log.
  condition: "Condition",
  purchase_date: "Bought on",
  price: "Price",
  supplier: "Supplier",
  retired: "Retired",
  missing: "Missing",
  merged_into: "Merged into",
};

export const fieldLabel = (field: string): string => LABELS[field] ?? field;

/** A stored value as a person reads it: names for ids, Yes/No for flags, a dash for nothing. */
export function describeValue(state: State, field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "home_location_id") return locationName(state, String(value));
  if (field === "parent_id" || field === "merged_into") return nameOf(state, String(value));
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (field === "price" && typeof value === "number") return `$${value.toFixed(2)}`;
  return String(value);
}

/** The item's own record changes, newest first. */
export function changes(store: Store, itemId: string): Change[] {
  const state = store.state;
  return store
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
