"""Reading derived state: what an item, a reservation, a ticket look like.

Pure functions over a state dict, the shape replay returns. The device answers
these questions in TypeScript (client/src/lib/inventory.ts, reservations.ts,
reports.ts, repairs.ts); the assistant needs the same answers on the server, so
they are here too. Keep the two in step.

Nothing here writes. Nothing here opens a database: callers hand in a snapshot.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from gear_tracker.replay import State

Fields = dict[str, Any]

DAY_MS = 24 * 3_600_000

MERGE_HOPS = 10
"""How far a chain of merges is followed (FR-INV-13). Matches resolveItem on the device."""


def table(state: State, entity_type: str) -> list[Fields]:
    """Every entity of a type, each with its id."""
    return [{"id": entity_id, **fields} for entity_id, fields in (state.get(entity_type) or {}).items()]


def entity(state: State, entity_type: str, entity_id: str) -> Fields | None:
    fields = (state.get(entity_type) or {}).get(entity_id)
    return None if fields is None else {"id": entity_id, **fields}


def iso(ms: int | None) -> str | None:
    """A timestamp as a person reads it. UTC, because the server has no better idea."""
    return None if ms is None else datetime.fromtimestamp(ms / 1000, UTC).isoformat(timespec="seconds")


def today(ms: int) -> str:
    """The calendar day where the server is, not where UTC is (NFR-DATA-12).

    A device asks its own browser; the server has only its own zone, which is
    set to the group's when it is deployed.
    """
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


# --- items -------------------------------------------------------------------------------


def items(state: State) -> list[Fields]:
    return table(state, "item")


def item(state: State, item_id: str) -> Fields | None:
    return entity(state, "item", item_id)


def resolve_item(state: State, item_id: str) -> str:
    """The item that stands for this id today: itself, or the survivor of a merge (FR-INV-13)."""
    current = item_id
    for _ in range(MERGE_HOPS):
        nxt = (state.get("item") or {}).get(current, {}).get("merged_into")
        if not nxt or nxt not in (state.get("item") or {}):
            return current
        current = nxt
    return current


def aliases(state: State, item_id: str) -> list[str]:
    """This id and every item merged into it. The first entry is the id itself."""
    found = [item_id]
    index = 0
    while index < len(found) and len(found) <= MERGE_HOPS * 10:
        for other, fields in (state.get("item") or {}).items():
            if fields.get("merged_into") == found[index] and other not in found:
                found.append(other)
        index += 1
    return found


def number_key(it: Fields) -> tuple[int, int, str]:
    """Unit numbers as people read them: whole numbers first and in numeric order,
    so 2 comes before 10, then everything else as text. The twin of byNumber in inventory.ts."""
    number = str(it.get("number") or "").strip()
    return (0, int(number), "") if number.isdigit() else (1, 0, number)


def units_of(state: State, generic_id: str) -> list[Fields]:
    """The units under a generic, in number order. Retired ones included; callers filter."""
    return sorted(
        (it for it in items(state) if it.get("parent_id") == generic_id and not it.get("merged_into")),
        key=number_key,
    )


def display_name(state: State, it: Fields) -> str:
    """ "4-person tent #3 (patched fly)" for a unit, the item's own name otherwise (FR-INV-22)."""
    if not it.get("parent_id"):
        return it.get("name") or ""
    parent = item(state, it["parent_id"])
    base = f"{(parent or {}).get('name') or '(unknown item)'} #{it.get('number') or '?'}"
    return f"{base} ({it['nickname']})" if it.get("nickname") else base


def name_of(state: State, item_id: str | None) -> str:
    it = item(state, item_id) if item_id else None
    return display_name(state, it) if it else "(unknown item)"


def location_name(state: State, location_id: str | None) -> str:
    if not location_id:
        return ""
    return (entity(state, "location", location_id) or {}).get("name") or "(unknown location)"


def home_label(state: State, it: Fields) -> str:
    """Home as people say it: "Warm locker / shelf 4" (FR-INV-02)."""
    loc = location_name(state, it.get("home_location_id"))
    sub = it.get("sub_location")
    if not sub:
        return loc
    return f"{loc} / {sub}" if loc else sub


def user_name(state: State, user_id: str | None) -> str:
    if not user_id:
        return ""
    return (entity(state, "user", user_id) or {}).get("name") or "(unknown person)"


def movable(state: State) -> list[Fields]:
    """Things that move: single items and units, never a generic (FR-INV-21)."""
    return [it for it in items(state) if not it.get("generic")]


def search(
    state: State,
    query: str = "",
    location_id: str | None = None,
    status: str | None = None,
    retired: bool = False,
) -> list[Fields]:
    """Search as you type (FR-INV-07), over the things that move. Every word must appear somewhere."""
    words = [w for w in query.lower().split() if w]

    def matches(it: Fields) -> bool:
        hay = f"{display_name(state, it)} {home_label(state, it)}".lower()
        return all(w in hay for w in words)

    def wanted(it: Fields) -> bool:
        if status is None:
            return True
        if status == "missing":
            return bool(it.get("missing"))
        return it.get("status") == status

    found = [
        it
        for it in movable(state)
        if not it.get("merged_into")
        and bool(it.get("retired")) == retired
        and (location_id is None or it.get("home_location_id") == location_id)
        and wanted(it)
        and matches(it)
    ]
    return sorted(found, key=lambda it: display_name(state, it))


def rows(
    state: State,
    query: str = "",
    location_id: str | None = None,
    status: str | None = None,
    retired: bool = False,
) -> list[Fields]:
    """The list: one row per generic with its counts, single items as rows of their own (FR-INV-25)."""
    singles: list[Fields] = []
    by_parent: dict[str, list[Fields]] = {}
    for it in search(state, query, location_id, status, retired):
        parent = it.get("parent_id") if it.get("parent_id") in (state.get("item") or {}) else None
        if parent:
            by_parent.setdefault(parent, []).append(it)
        else:
            singles.append({"kind": "single", "item": it, "name": display_name(state, it)})

    if location_id is None and status is None:
        # An empty generic is still a row when only the search text is set, so one can be found and given units.
        words = [w for w in query.lower().split() if w]
        for generic in items(state):
            if not generic.get("generic") or generic.get("merged_into"):
                continue
            if bool(generic.get("retired")) != retired:
                continue
            hay = f"{display_name(state, generic)} {home_label(state, generic)}".lower()
            if all(w in hay for w in words) and generic["id"] not in by_parent:
                by_parent[generic["id"]] = []

    grouped: list[Fields] = []
    for generic_id, units in by_parent.items():
        parent = item(state, generic_id) or {"id": generic_id}
        grouped.append(
            {
                "kind": "generic",
                "item": parent,
                "name": display_name(state, parent),
                "units": sorted(units, key=number_key),
                "counts": {
                    "total": len(units),
                    "in": sum(1 for u in units if u.get("status") == "in" and not u.get("missing")),
                },
            }
        )
    return sorted([*grouped, *singles], key=lambda row: row["name"])


# --- what is out -------------------------------------------------------------------------


def days_out(it: Fields, now: int) -> int:
    return max(0, now - (it.get("since") or now)) // DAY_MS


def overdue_days(state: State) -> int | None:
    days = ((state.get("setting") or {}).get("group") or {}).get("overdue_days")
    return days if isinstance(days, int) and days > 0 else None


def is_overdue(state: State, it: Fields, now: int) -> bool:
    """Out longer than the group-wide period (FR-OUT-14). No period set means nothing is overdue."""
    days = overdue_days(state)
    return it.get("status") == "out" and days is not None and days_out(it, now) >= days


def what_is_out(state: State, now: int) -> dict[str, Any]:
    """Everyone who has something, by name (FR-RPT-01). Missing gear is not out (FR-INV-19)."""
    by_holder: dict[str, list[Fields]] = {}
    overdue = 0
    for it in items(state):
        if it.get("status") != "out" or it.get("missing"):
            continue
        movement = it.get("movement") or {}
        entry = {
            "item_id": it["id"],
            "name": display_name(state, it),
            "days": days_out(it, now),
            "event": movement.get("event"),
            "overdue": is_overdue(state, it, now),
        }
        if entry["overdue"]:
            overdue += 1
        by_holder.setdefault(it.get("holder_id") or "", []).append(entry)

    holders = sorted(
        (
            {
                "holder_id": holder_id or None,
                "holder": user_name(state, holder_id) if holder_id else "(no holder)",
                "items": sorted(entries, key=lambda e: (-e["days"], e["name"])),
            }
            for holder_id, entries in by_holder.items()
        ),
        key=lambda h: h["holder"],
    )
    return {"holders": holders, "total": sum(len(h["items"]) for h in holders), "overdue": overdue}


# --- reservations -----------------------------------------------------------------------


def reservations(state: State) -> list[Fields]:
    """Every reservation not cancelled, first day first."""
    live = [r for r in table(state, "reservation") if not r.get("cancelled")]
    return sorted(live, key=lambda r: (r.get("starts") or "", r.get("event") or ""))


def reservation(state: State, reservation_id: str) -> Fields | None:
    return entity(state, "reservation", reservation_id)


def overlaps(a: Fields, b: Fields) -> bool:
    """Inclusive: two camps that share a day share the gear."""
    return a["starts"] <= b["ends"] and b["starts"] <= a["ends"]


def named_items(state: State, r: Fields) -> list[str]:
    """The items a reservation names, as they stand today: a merged duplicate means its survivor."""
    seen: dict[str, None] = {}
    for item_id in r.get("items") or []:
        seen.setdefault(resolve_item(state, item_id), None)
    return list(seen)


def _ticked(it: Fields, event: str) -> bool:
    return it.get("status") == "out" and (it.get("movement") or {}).get("event") == event


def remaining(state: State, r: Fields) -> dict[str, Any]:
    """What is still to pack (FR-RES-06). Derived from state alone: a scan anywhere ticks it here after sync."""
    named = [it for it in (item(state, i) for i in named_items(state, r)) if it is not None]
    named.sort(key=lambda it: (home_label(state, it), display_name(state, it)))
    event = r.get("event") or ""
    chosen = set(named_items(state, r))

    generics = []
    for line in r.get("generics") or []:
        generic = item(state, line["item_id"]) or {"id": line["item_id"], "name": "(unknown item)"}
        # Any unit of the generic counts, except one the reservation names: that one is its own line.
        done = sum(1 for u in units_of(state, line["item_id"]) if u["id"] not in chosen and _ticked(u, event))
        generics.append(
            {
                "item_id": line["item_id"],
                "name": display_name(state, generic),
                "quantity": line["quantity"],
                "done": min(done, line["quantity"]),
            }
        )

    return {
        "items": [_packing_row(state, it) for it in named if not _ticked(it, event)],
        "packed": [_packing_row(state, it) for it in named if _ticked(it, event)],
        "generics": generics,
    }


def _packing_row(state: State, it: Fields) -> Fields:
    return {"item_id": it["id"], "name": display_name(state, it), "home": home_label(state, it)}


def is_packed(rem: dict[str, Any]) -> bool:
    return not rem["items"] and all(g["done"] >= g["quantity"] for g in rem["generics"])


# --- repairs ----------------------------------------------------------------------------

OPEN_REPAIR_STATES = ("open", "in_progress")
"""A ticket in one of these flags its item (FR-REP-05)."""


def repairs(state: State) -> list[Fields]:
    return table(state, "repair")


def is_open(ticket: Fields) -> bool:
    return ticket.get("state") in OPEN_REPAIR_STATES


def open_tickets(state: State) -> list[Fields]:
    """Everything still to fix, newest first."""
    return sorted((t for t in repairs(state) if is_open(t)), key=lambda t: (-(t.get("added_at") or 0), t["id"]))


def repairs_for(state: State, item_id: str) -> list[Fields]:
    """The item's tickets, open first then newest first (FR-REP-04). A merged duplicate's come too."""
    own = aliases(state, item_id)
    found = [t for t in repairs(state) if t.get("item_id") in own]
    return sorted(found, key=lambda t: (not is_open(t), -(t.get("added_at") or 0), t["id"]))


# --- locations --------------------------------------------------------------------------


def locations(state: State) -> list[Fields]:
    return sorted(
        (loc for loc in table(state, "location") if not loc.get("deleted")), key=lambda x: x.get("name") or ""
    )
