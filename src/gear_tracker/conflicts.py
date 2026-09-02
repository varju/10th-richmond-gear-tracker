"""Reservation clashes: what a draft cannot share its dates with (FR-RES-05, FR-RES-15).

This runs twice, here and in TypeScript on the device (client/src/lib/reservations.ts).
The shared vectors under vectors/reservations/ are the contract, the same
arrangement as replay. The assistant needs the answer in its reply (FR-MCP-06),
so a device is not the only place that can work it out.

Change a rule here, change a vector, and the other side fails until it catches up.
"""

from __future__ import annotations

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

    # Only for generics the draft reserves by count. Named units count once each, however many
    # reservations name them; naming the same tent twice is the item clash above, not a count one.
    involved = [draft, *others]
    for generic_id in dict.fromkeys(line["item_id"] for line in draft.get("generics") or []):
        owned = sum(1 for unit in views.units_of(state, generic_id) if not unit.get("retired"))

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
