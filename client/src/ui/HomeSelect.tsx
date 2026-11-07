import { locations } from "../lib/inventory";
import type { State } from "../lib/replay";

const KEPT = "user:";

interface Props {
  state: State;
  location_id: string | null | undefined;
  user_id: string | null | undefined;
  /** Who can be picked, by name. A person already chosen but missing here is added. */
  people: { id: string; name: string }[];
  none: string;
  /** Exactly one of the two is set, or neither for "none". */
  onChange: (pick: { location_id: string | null; user_id: string | null }) => void;
}

/** A location or a person ("Kept by"), in one select (FR-INV-59). Shared by the item form and the list filter. */
export function HomeSelect({ state, location_id, user_id, people, none, onChange }: Props) {
  const chosen = user_id && !people.some((u) => u.id === user_id);
  const who = chosen ? state.user?.[user_id] : undefined;
  const name = chosen
    ? `${(who?.name as string | undefined) ?? "Unknown person"}${who?.active === false ? " (inactive)" : ""}`
    : "";
  const all = chosen ? [...people, { id: user_id, name }] : people;
  return (
    <select
      value={user_id ? KEPT + user_id : location_id ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v.startsWith(KEPT)) onChange({ location_id: null, user_id: v.slice(KEPT.length) });
        else onChange({ location_id: v || null, user_id: null });
      }}
    >
      <option value="">{none}</option>
      {locations(state).map((l) => (
        <option key={l.id} value={l.id}>
          {l.name}
        </option>
      ))}
      {all.length > 0 && (
        <optgroup label="Kept by">
          {all.map((u) => (
            <option key={u.id} value={KEPT + u.id}>
              {u.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
