"""Reading derived state: what an item, a reservation, a ticket look like.

Pure functions over a state dict, the shape replay returns. The device answers
these questions in TypeScript (client/src/lib/inventory.ts, reservations.ts,
reports.ts, repairs.ts); the assistant needs the same answers on the server, so
they are here too. Keep the two in step.

Nothing here writes. Nothing here opens a database: callers hand in a snapshot.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any

from gear_tracker.replay import State, cleaner_key, keep_newest

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
    """Every item worth listing. A deleted one is gone from here, as a deleted location is (FR-INV-32)."""
    return [it for it in table(state, "item") if not it.get("deleted")]


def item(state: State, item_id: str) -> Fields | None:
    """One item by id, deleted ones included, so an old reference can still name it (FR-INV-32)."""
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


def codes_for(state: State, item_id: str) -> list[str]:
    """Every code that resolves, through merges, to this item: the one bound last first, so the
    first is its current code and the rest are replaced (FR-TAG-05).

    A released code (FR-TAG-14) has no `item_id` and is never listed. Two codes bound in the same
    millisecond are ordered by id, the larger first. Mirrors codesFor in inventory.ts."""
    found: list[tuple[int, str]] = []
    for code_id, fields in (state.get("code") or {}).items():
        bound_item = fields.get("item_id")
        if bound_item is None or resolve_item(state, bound_item) != item_id:
            continue
        found.append((fields.get("bound_at") or 0, code_id))
    return [code_id for _, code_id in sorted(found, reverse=True)]


def current_code(state: State, item_id: str) -> str | None:
    """The code bound last that resolves to this item. Mirrors currentCode in inventory.ts."""
    return next(iter(codes_for(state, item_id)), None)


def bound_items(state: State) -> set[str]:
    """Every item that has a code, through merges; a released code has no item. Agrees with current_code."""
    return {resolve_item(state, f["item_id"]) for f in (state.get("code") or {}).values() if f.get("item_id")}


def lacks(state: State, it: Fields, needs: str, bound: set[str]) -> bool:
    """True when the item lacks what `needs` names. A location that is gone counts as none.
    Twin of lacks in inventory.ts."""
    if needs == "code":
        return it["id"] not in bound
    if needs == "location":
        if it.get("home_user_id"):
            return False
        loc = (state.get("location") or {}).get(it.get("home_location_id") or "")
        return loc is None or bool(loc.get("deleted"))
    if it.get("home_user_id"):
        return False
    return not (it.get("sub_location") or "").strip()


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


def keeper_label(state: State, user_id: str) -> str:
    """ "Kept by Sam", with "(inactive)" once Sam is deactivated (FR-INV-59)."""
    user = entity(state, "user", user_id)
    name = (user or {}).get("name") or "(unknown person)"
    return f"Kept by {name} (inactive)" if user and user.get("active") is False else f"Kept by {name}"


def home_label(state: State, it: Fields) -> str:
    """Home as people say it: "Warm locker / shelf 4" (FR-INV-02), or "Kept by Sam" (FR-INV-59)."""
    if it.get("home_user_id"):
        return keeper_label(state, it["home_user_id"])
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


def is_pool(it: Fields) -> bool:
    """A counted stack, not units (FR-INV-34). Always a generic; never has a code or a movement of its own."""
    return bool(it.get("pool"))


LB_PER_KG = 2.20462262185


def _convert(value: float, source: str, target: str) -> float:
    if source == target:
        return value
    return value * LB_PER_KG if target == "lb" else value / LB_PER_KG


def _tenth(value: float) -> int | float:
    """To one decimal, halves up, a whole number when it is one. Mirrors roundTenth in weighing.ts."""
    rounded = math.floor(value * 10 + 0.5) / 10
    return int(rounded) if rounded == int(rounded) else rounded


def _sound(w: Any, positive: bool = False) -> bool:
    """A weight a device could have written: a finite number, above zero if `positive`, in lb or kg. See isWeight."""
    value = w.get("value") if isinstance(w, dict) else None
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and (value > 0 if positive else value >= 0)
        and w.get("unit") in ("lb", "kg")
    )


def weight_fields(state: State, it: Fields) -> tuple[Fields | None, Fields | None]:
    """An item's empty weight and capacity as set, a unit's capacity falling back to its generic's (FR-INV-63)."""
    parent = item(state, it["parent_id"]) if it.get("parent_id") else None
    return it.get("empty_weight"), it.get("capacity") or (parent or {}).get("capacity")


def weighing(state: State, it: Fields) -> Fields | None:
    """An item that is weighed to see what is left (FR-INV-62): a sound empty weight and a capacity above zero.
    Mirrors weighing in weighing.ts. None otherwise, and for a generic."""
    empty, capacity = weight_fields(state, it)
    if it.get("generic") or empty is None or capacity is None:
        return None
    if not _sound(empty) or not _sound(capacity, positive=True):
        return None
    return {"empty_weight": empty, "capacity": capacity, "unit": empty["unit"]}


def amount_left(state: State, it: Fields, w: Fields | None = None) -> Fields | None:
    """What is left, from the latest reading, in the item's own unit (FR-INV-66). Mirrors amountLeft in
    weighing.ts. None when it is not weighed, the last reading was Unknown, or the item has been out since it
    (FR-INV-69). `w` is `weighing(state, it)` when the caller has it already."""
    w = w or weighing(state, it)
    reading = it.get("reading")
    if w is None or not isinstance(reading, dict) or reading.get("stale"):
        return None
    unit = w["unit"]
    capacity = _convert(w["capacity"]["value"], w["capacity"]["unit"], unit)
    if reading.get("full"):
        left = capacity
    elif _sound(reading):
        gross = _convert(reading["value"], reading["unit"], unit)
        left = min(max(gross - w["empty_weight"]["value"], 0), capacity)
    else:
        return None
    return {
        "left": _tenth(left),
        "unit": unit,
        "percent": math.floor(left / capacity * 100 + 0.5),
        "full": bool(reading.get("full")),
        "at": reading.get("at"),
    }


def pool_counts(it: Fields) -> Fields:
    """Owned, in, missing, and out by holder (FR-INV-36). Mirrors poolCounts in inventory.ts. Holders at zero are
    absent. Owned is in, out and missing together."""
    pool_in = it.get("pool_in") or 0
    out = [
        {"holder_id": holder_id, "count": count} for holder_id, count in (it.get("pool_out") or {}).items() if count > 0
    ]
    missing = it.get("pool_missing") or 0
    owned = pool_in + sum(o["count"] for o in out) + missing
    return {"owned": owned, "in": pool_in, "missing": missing, "out": out}


def pool_lots(it: Fields) -> list[Fields]:
    """One holder's count, split by the check-outs it came from. Mirrors poolLots in inventory.ts."""
    found = []
    for out in pool_counts(it)["out"]:
        lots = keep_newest((it.get("pool_lots") or {}).get(out["holder_id"], []), out["count"])
        found.append({**out, "lots": lots, "unknown": out["count"] - sum(lot["count"] for lot in lots)})
    return found


def event_name_key(name: str) -> str:
    """What makes two names the same event: case and spacing aside. Mirrors eventNameKey in calendar.ts."""
    return " ".join(name.split()).lower()


def active_users(state: State) -> list[Fields]:
    """Members who can hold gear, by name. Mirrors activeUsers in inventory.ts."""
    found = [{**u, "name": u.get("name") or u["id"]} for u in table(state, "user") if u.get("active") is not False]
    return sorted(found, key=lambda u: u["name"].lower())


def open_conflicts(state: State) -> list[Fields]:
    """Double check-outs nothing has settled (FR-OFF-10), oldest later check-out first. Mirrors
    openConflicts in conflicts.ts: open while the later check-out is still the item's current
    movement and nobody has reviewed it."""
    found = []
    for it in items(state):
        current = (it.get("movement") or {}).get("id")
        if not current:
            continue
        for c in it.get("conflicts") or []:
            earlier, later = c["events"]
            if later["id"] == current and it.get("reviewed_movement") != later["id"]:
                found.append({"item": it, "earlier": earlier, "later": later})
                break
    return sorted(found, key=lambda c: (c["later"]["at"], c["item"]["id"]))


def has_gear_out(state: State, it: Fields) -> bool:
    """True when this item, in whatever shape it takes, has gear away from the shelf: an ordinary
    item checked out, a pool with any holder's count above zero, or a generic with a unit out."""
    if is_pool(it):
        return any(count > 0 for count in (it.get("pool_out") or {}).values())
    if it.get("generic"):
        return any(u.get("status") == "out" for u in units_of(state, it["id"]))
    return it.get("status") == "out"


def search(
    state: State,
    query: str = "",
    location_id: str | None = None,
    status: str | None = None,
    retired: bool = False,
    needs: str | None = None,
    home_user_id: str | None = None,
) -> list[Fields]:
    """Search as you type (FR-INV-07), over the things that move. Every word must appear somewhere."""
    return _search_with(state, query, location_id, status, retired, needs, home_user_id, _bound_for(state, needs))


def _bound_for(state: State, needs: str | None) -> set[str]:
    return bound_items(state) if needs == "code" else set()


def _search_with(
    state: State,
    query: str,
    location_id: str | None,
    status: str | None,
    retired: bool,
    needs: str | None,
    home_user_id: str | None,
    bound: set[str],
) -> list[Fields]:
    words = [w for w in query.lower().split() if w]

    def matches(it: Fields) -> bool:
        hay = f"{display_name(state, it)} {home_label(state, it)}".lower()
        return all(w in hay for w in words)

    def wanted(it: Fields) -> bool:
        if needs is not None and not lacks(state, it, needs, bound):
            return False
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
        and (home_user_id is None or it.get("home_user_id") == home_user_id)
        and matches(it)
        and wanted(it)
    ]
    return sorted(found, key=lambda it: display_name(state, it))


def rows(
    state: State,
    query: str = "",
    location_id: str | None = None,
    status: str | None = None,
    retired: bool = False,
    needs: str | None = None,
    home_user_id: str | None = None,
) -> list[Fields]:
    """The list: one row per generic with its counts, single items as rows of their own (FR-INV-25).
    A pool is its own row kind, with its counts instead of units (FR-INV-36). A generic's counts cover all its
    live units; `units` are the ones matching the filters."""
    singles: list[Fields] = []
    pools: list[Fields] = []
    by_parent: dict[str, list[Fields]] = {}
    bound = _bound_for(state, needs)
    for it in _search_with(state, query, location_id, status, retired, needs, home_user_id, bound):
        parent = it.get("parent_id") if it.get("parent_id") in (state.get("item") or {}) else None
        if parent:
            by_parent.setdefault(parent, []).append(it)
        else:
            singles.append({"kind": "single", "item": it, "name": display_name(state, it)})

    words = [w for w in query.lower().split() if w]

    def pool_wanted(pool: Fields) -> bool:
        """A pool has no units for search() to filter, so it is matched here: on its home for a
        location filter, on what it lacks for a needs filter, and on its counts for a status filter
        ("in" means stock on the shelf, "out" means anything checked out to a holder,
        "missing" means a missing count above zero)."""
        if location_id is not None and pool.get("home_location_id") != location_id:
            return False
        if home_user_id is not None and pool.get("home_user_id") != home_user_id:
            return False
        if needs is not None and not lacks(state, pool, needs, bound):
            return False
        if status == "in":
            return (pool.get("pool_in") or 0) > 0
        if status == "out":
            return any(count > 0 for count in (pool.get("pool_out") or {}).values())
        if status == "missing":
            return (pool.get("pool_missing") or 0) > 0
        return True

    for generic in items(state):
        if not generic.get("generic") or generic.get("merged_into") or generic["id"] in by_parent:
            continue
        if bool(generic.get("retired")) != retired:
            continue
        hay = f"{display_name(state, generic)} {home_label(state, generic)}".lower()
        if not all(w in hay for w in words):
            continue
        if is_pool(generic):
            if pool_wanted(generic):
                pools.append(
                    {
                        "kind": "pool",
                        "item": generic,
                        "name": display_name(state, generic),
                        "counts": pool_counts(generic),
                    }
                )
        elif location_id is None and home_user_id is None and status is None and needs is None:
            # An empty generic is still a row when only the search text is set, so one can be found and given units.
            by_parent[generic["id"]] = []

    children: dict[str, list[Fields]] = {}
    for it in items(state):
        if it.get("parent_id") and not it.get("merged_into"):
            children.setdefault(it["parent_id"], []).append(it)

    grouped: list[Fields] = []
    for generic_id, units in by_parent.items():
        parent = item(state, generic_id) or {"id": generic_id}
        every = [u for u in children.get(generic_id, []) if bool(u.get("retired")) == retired]
        grouped.append(
            {
                "kind": "generic",
                "item": parent,
                "name": display_name(state, parent),
                "units": sorted(units, key=number_key),
                "counts": {
                    "in": sum(1 for u in every if u.get("status") == "in" and not u.get("missing")),
                    "out": sum(1 for u in every if u.get("status") == "out" and not u.get("missing")),
                    "missing": sum(1 for u in every if u.get("missing")),
                },
            }
        )
    return sorted([*grouped, *singles, *pools], key=lambda row: row["name"])


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


def what_is_out(state: State, now: int, event: str | None = None) -> dict[str, Any]:
    """Everyone who has something, by name (FR-RPT-01). Missing gear is not out (FR-INV-19).

    `event` keeps only that event's gear, case and spacing aside (FR-RPT-13).

    A pool has no single "out"; it lists once per holder and event, with its count, and carries no
    days, because a count can be the sum of check-outs at different times (FR-RPT-11).
    """
    by_holder: dict[str, list[Fields]] = {}
    for it in items(state):
        if is_pool(it):
            if not it.get("retired"):
                for out in pool_lots(it):
                    lines: dict[tuple[str, str], Fields] = {}
                    under = [(lot["event"], lot.get("cleaner"), lot["count"]) for lot in out["lots"]]
                    if out["unknown"]:
                        under.append((None, None, out["unknown"]))
                    for name, cleaner, count in under:
                        key = (event_name_key(name) if name else "", cleaner_key(cleaner) if cleaner else "")
                        if key in lines:
                            lines[key]["count"] += count
                        else:
                            lines[key] = {
                                "item_id": it["id"],
                                "name": display_name(state, it),
                                "days": 0,
                                "event": " ".join(name.split()) if name else None,
                                "overdue": False,
                                "count": count,
                            }
                            if cleaner:
                                lines[key]["cleaner"] = " ".join(cleaner.split())
                    by_holder.setdefault(out["holder_id"], []).extend(lines.values())
            continue
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
        if movement.get("cleaner"):
            entry["cleaner"] = " ".join(movement["cleaner"].split())
        by_holder.setdefault(it.get("holder_id") or "", []).append(entry)

    wanted = event_name_key(event or "")
    if wanted:
        by_holder = {
            holder_id: found
            for holder_id, entries in by_holder.items()
            if (found := [e for e in entries if e["event"] and event_name_key(e["event"]) == wanted])
        }

    def _holder_entry(holder_id: str, entries: list[Fields]) -> Fields:
        return {
            "holder_id": holder_id or None,
            "holder": user_name(state, holder_id) if holder_id else "(no holder)",
            "items": sorted(entries, key=lambda e: (-e.get("days", 0), e["name"])),
        }

    holders = sorted(
        (_holder_entry(holder_id, entries) for holder_id, entries in by_holder.items()),
        key=lambda h: h["holder"],
    )
    # A pool under two events is still one thing this person has.
    total = sum(len({entry["item_id"] for entry in h["items"]}) for h in holders)
    overdue = sum(1 for h in holders for entry in h["items"] if entry["overdue"])
    return {"holders": holders, "total": total, "overdue": overdue}


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
    """The items a reservation names, as they stand today: a merged duplicate means its survivor.

    A deleted record is not there at all (FR-INV-32). The twin of namedItems in reservations.ts.
    """
    seen: dict[str, None] = {}
    for item_id in r.get("items") or []:
        seen.setdefault(resolve_item(state, item_id), None)
    return [item_id for item_id in seen if not (state.get("item") or {}).get(item_id, {}).get("deleted")]


def _went_out(it: Fields, reservation_id: str) -> bool:
    """Out under a check-out that named this reservation (FR-RES-13). Not the event: an event
    name repeats year to year, and would read next year's camp as already packed on day one."""
    return it.get("status") == "out" and (it.get("movement") or {}).get("reservation_id") == reservation_id


def _ticked(it: Fields, reservation_id: str) -> bool:
    """Gear at a cleaner's home is not with the camp, so it is not packed (FR-RES-36)."""
    return _went_out(it, reservation_id) and not (it.get("movement") or {}).get("cleaner")


def pool_out(it: Fields, reservation_id: str, home_too: bool) -> int:
    """How much of a stack is out under the reservation, leaving out what is at someone's home unless home_too.
    Mirrors poolOut in reservations.ts."""
    return sum(
        lot["count"]
        for out in pool_lots(it)
        for lot in out["lots"]
        if lot.get("reservation_id") == reservation_id and (home_too or not lot.get("cleaner"))
    )


def pool_packed(it: Fields, reservation_id: str) -> int:
    """Out under the reservation and not at someone's home (FR-RES-36). Mirrors poolPacked in reservations.ts."""
    return pool_out(it, reservation_id, False)


def remaining(state: State, r: Fields) -> dict[str, Any]:
    """What is still to pack (FR-RES-06). Derived from state alone: a scan anywhere ticks it here after sync."""
    named = [it for it in (item(state, i) for i in named_items(state, r)) if it is not None]
    named.sort(key=lambda it: (home_label(state, it), display_name(state, it)))
    reservation_id = r["id"]
    chosen = set(named_items(state, r))

    generics = []
    for line in r.get("generics") or []:
        generic = item(state, line["item_id"]) or {"id": line["item_id"], "name": "(unknown item)"}
        if is_pool(generic):
            # The lots, not pool_reservations, which only ever grows and so still counts what came back.
            done = pool_packed(generic, reservation_id)
        else:
            # Any unretired unit of the generic counts, except one the reservation names: that one is its own line.
            done = sum(
                1
                for u in units_of(state, line["item_id"])
                if u["id"] not in chosen and not u.get("retired") and _ticked(u, reservation_id)
            )
        generics.append(
            {
                "item_id": line["item_id"],
                "name": display_name(state, generic),
                "quantity": line["quantity"],
                "done": min(done, line["quantity"]),
            }
        )

    return {
        "items": [_packing_row(state, it) for it in named if not _ticked(it, reservation_id)],
        "packed": [_packing_row(state, it) for it in named if _ticked(it, reservation_id)],
        "generics": generics,
    }


def outstanding(state: State, r: Fields) -> dict[str, Any]:
    """What is still out under the event, at a cleaner's home or not. Mirrors outstanding in reservations.ts."""
    reservation_id = r["id"]
    names = named_items(state, r)
    chosen = set(names)
    named = [it for it in (item(state, i) for i in names) if it is not None and _went_out(it, reservation_id)]
    named.sort(key=lambda it: (home_label(state, it), display_name(state, it)))

    generics = []
    for line in r.get("generics") or []:
        generic = item(state, line["item_id"]) or {"id": line["item_id"], "name": "(unknown item)"}
        if is_pool(generic):
            out = pool_out(generic, reservation_id, True)
        else:
            out = sum(
                1
                for u in units_of(state, line["item_id"])
                if u["id"] not in chosen and not u.get("retired") and _went_out(u, reservation_id)
            )
        generics.append(
            {
                "item_id": line["item_id"],
                "name": display_name(state, generic),
                "quantity": line["quantity"],
                "out": out,
            }
        )
    return {"items": [_packing_row(state, it) for it in named], "generics": generics}


def _packing_row(state: State, it: Fields) -> Fields:
    row = {"item_id": it["id"], "name": display_name(state, it), "home": home_label(state, it)}
    if it.get("status") == "out" and (it.get("movement") or {}).get("cleaner"):
        row["cleaner"] = it["movement"]["cleaner"]
    return row


def is_packed(rem: dict[str, Any]) -> bool:
    return not rem["items"] and all(g["done"] >= g["quantity"] for g in rem["generics"])


# --- repairs ----------------------------------------------------------------------------

OPEN_REPAIR_STATES = ("open", "in_progress")
"""A ticket in one of these flags its item (FR-REP-05)."""


def repairs(state: State) -> list[Fields]:
    """A deleted ticket is gone from every list (FR-REP-10)."""
    return [t for t in table(state, "repair") if not t.get("deleted")]


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


# --- locations and categories -------------------------------------------------------------


def locations(state: State) -> list[Fields]:
    return sorted(
        (loc for loc in table(state, "location") if not loc.get("deleted")), key=lambda x: x.get("name") or ""
    )


def categories(state: State) -> list[Fields]:
    return sorted(
        (cat for cat in table(state, "category") if not cat.get("deleted")), key=lambda x: x.get("name") or ""
    )


def category_name(state: State, category_id: str | None) -> str:
    if not category_id:
        return ""
    return (entity(state, "category", category_id) or {}).get("name") or "(unknown category)"


def _raw_category_ids(it: Fields) -> list[str]:
    """category_ids (even empty) or the legacy category_id, read straight off this record: no
    parent resolution, no check against live categories. Mirrors rawCategoryIds in inventory.ts."""
    if "category_ids" in it:
        return it.get("category_ids") or []
    if it.get("category_id"):
        return [it["category_id"]]
    return []


def categories_of(state: State, it: Fields) -> list[str]:
    """A unit reads its generic's categories, so re-filing a generic re-files its units.

    `category_ids` wins when present, even empty; a bare `category_id` from before September
    2026 reads as a list of one. Either way, an id that no longer names a live category is
    dropped.
    """
    source = (item(state, it["parent_id"]) if it.get("parent_id") else it) or {}
    live = {cat["id"] for cat in categories(state)}
    return [cid for cid in _raw_category_ids(source) if cid in live]


def purchase_of(state: State, it: Fields) -> tuple[str | None, str | None]:
    """The purchase date in use and where it comes from: "item", "generic" (a unit with none of its own), or None."""
    own = it.get("purchase_date")
    if own:
        return own, "item"
    parent = item(state, it["parent_id"]) if it.get("parent_id") else None
    inherited = (parent or {}).get("purchase_date")
    return (inherited, "generic") if inherited else (None, None)


def category_names(state: State, it: Fields) -> str:
    """The item's categories on one line: "Tents, Tarps", or "" for none."""
    return ", ".join(category_name(state, cid) for cid in categories_of(state, it))


def location_blockers(state: State, location_id: str) -> list[Fields]:
    """Items that stop a location being deleted (FR-SET-05). Retired items count: they can come back.

    Mirrors `blockers` in inventory.ts.
    """
    found = [it for it in items(state) if it.get("home_location_id") == location_id]
    return sorted(found, key=lambda it: display_name(state, it))


def category_blockers(state: State, category_id: str) -> list[Fields]:
    """Items that stop a category being deleted (FR-SET-05). Raw ids, not categories_of: a
    category already gone from categories(state) must still be able to name what was pointing at
    it. Mirrors `categoryBlockers` in inventory.ts."""
    return sorted(
        (it for it in items(state) if category_id in _raw_category_ids(it)), key=lambda it: display_name(state, it)
    )


# --- group setting -------------------------------------------------------------------------


def group_name(state: State) -> str:
    """The group name, or "" before one is set. Matches `group_name` in app.py, from a snapshot instead of a
    connection."""
    return (entity(state, "setting", "group") or {}).get("name") or ""
