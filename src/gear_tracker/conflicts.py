"""Reservation clashes: what a draft cannot share its dates with (FR-RES-05, FR-RES-15).

This runs twice, here and in TypeScript on the device (client/src/lib/reservations.ts).
The shared vectors under vectors/reservations/ are the contract, the same
arrangement as replay. The assistant needs the answer in its reply (FR-MCP-06),
so a device is not the only place that can work it out.

Change a rule here, change a vector, and the other side fails until it catches up.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from gear_tracker import views
from gear_tracker.replay import State

Draft = dict[str, Any]
"""An event, its days, and what it needs: `event`, `starts`, `ends`, `items`, `generics`."""


def conflicts(state: State, draft: Draft, exclude_id: str | None = None) -> list[dict[str, str]]:
    """Other reservations this one cannot share the dates with. One entry each.

    An item named in both is a clash. A generic is a clash when everything
    reserved of it across the overlapping dates, by count or by name, is more
    than we have unretired units (FR-RES-15).
    """
    others = [r for r in views.reservations(state) if r["id"] != exclude_id and views.overlaps(r, draft)]
    found: dict[str, list[str]] = {}

    def add(other: Draft, detail: str) -> None:
        found.setdefault(other["id"], []).append(detail)

    for other in others:
        theirs = views.named_items(state, other)
        for item_id in views.named_items(state, draft):
            if item_id in theirs:
                add(other, views.name_of(state, item_id))

    # For every generic the draft reserves, whether by count or by naming one of its units (FR-RES-15):
    # a draft that only names a unit must still be capacity-checked, not just one that reserves by
    # count. Named units count once each, however many reservations name them; naming the same tent
    # twice is the item clash above, not a count one.
    involved = [draft, *others]
    draft_generic_ids = dict.fromkeys(
        [line["item_id"] for line in draft.get("generics") or []]
        + [
            parent_id
            for i in views.named_items(state, draft)
            if (parent_id := (views.item(state, i) or {}).get("parent_id"))
        ]
    )
    for generic_id in draft_generic_ids:
        generic = views.item(state, generic_id)
        # A pool's stock is what it owns (FR-INV-36), not a count of units: it has none (FR-INV-34).
        owned = (
            views.pool_counts(generic)["owned"]
            if generic and views.is_pool(generic)
            else sum(1 for unit in views.units_of(state, generic_id) if not unit.get("retired"))
        )

        def by_count(r: Draft, generic_id: str = generic_id) -> int:
            return sum(line["quantity"] for line in r.get("generics") or [] if line["item_id"] == generic_id)

        def by_name(r: Draft, generic_id: str = generic_id) -> list[str]:
            return [
                i for i in views.named_items(state, r) if (views.item(state, i) or {}).get("parent_id") == generic_id
            ]

        named = {item_id for r in involved for item_id in by_name(r)}
        total = len(named) + sum(by_count(r) for r in involved)
        if total > owned:
            detail = f"{total} × {views.name_of(state, generic_id)}, we have {owned}"
            for other in others:
                if by_count(other) > 0 or by_name(other):
                    add(other, detail)

    by_id = {r["id"]: r for r in others}
    return [
        {"id": other_id, "event": by_id[other_id].get("event") or "", "detail": ", ".join(details)}
        for other_id, details in found.items()
    ]


def describe(clashes: list[dict[str, str]]) -> str:
    """The sentence the app shows when it refuses to save (FR-RES-05). The assistant says the same thing."""
    return "Already reserved for " + "; ".join(f"{c['event']} ({c['detail']})" for c in clashes) + "."


def _shift(iso: str, days: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()


def _near_window(r: Draft) -> Draft:
    """Seven days either side (FR-RES-19)."""
    return {"starts": _shift(r["starts"], -7), "ends": _shift(r["ends"], 7)}


def _short_dates(r: Draft) -> str:
    starts, ends = r.get("starts") or "", r.get("ends") or ""
    return starts if starts == ends else f"{starts} – {ends}"


def nearby(state: State, draft: Draft, exclude_id: str | None = None) -> dict[str, list[dict[str, str]]]:
    """A line this draft shares with a camp nearby but not overlapping (FR-RES-19): its dates fall
    within seven days either side of the draft's. Keyed by item id and by generic id, whichever the
    other reservation names the same way (by unit or by count). Empty for nothing near; a hint
    before the block, since an overlap is refused by `conflicts` instead. Twin of `nearby` in
    reservations.ts.
    """
    if not draft.get("starts") or not draft.get("ends"):
        return {}
    window = _near_window(draft)
    others = [
        r
        for r in views.reservations(state)
        if r["id"] != exclude_id and not views.overlaps(r, draft) and views.overlaps(r, window)
    ]
    found: dict[str, list[dict[str, str]]] = {}

    def add(item_id: str, other: Draft) -> None:
        found.setdefault(item_id, []).append({"event": other.get("event") or "", "detail": _short_dates(other)})

    for other in others:
        theirs = set(views.named_items(state, other))
        for item_id in draft.get("items") or []:
            if item_id in theirs:
                add(item_id, other)
        for line in draft.get("generics") or []:
            generic_id = line["item_id"]
            by_count = any(g["item_id"] == generic_id for g in other.get("generics") or [])
            by_name = any(
                (views.item(state, i) or {}).get("parent_id") == generic_id for i in views.named_items(state, other)
            )
            if by_count or by_name:
                add(generic_id, other)

    return found


def near_label(notes: list[dict[str, str]]) -> str:
    """'Needed for Fall Camp, 2026-10-02 – 2026-10-04'. Joins more than one nearby camp with '; '."""
    return "Needed for " + "; ".join(f"{n['event']}, {n['detail']}" for n in notes)
