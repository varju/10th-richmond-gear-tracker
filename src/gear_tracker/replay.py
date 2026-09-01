"""Replay: events in, current state out. Pure.

This runs twice, here and in TypeScript on the device, and the two must agree.
The shared vectors under vectors/replay/ are the contract (NFR-MAINT-04). Change
the rules here, change the vectors, and the other side fails until it catches up.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from gear_tracker.events import Event

State = dict[str, dict[str, dict[str, Any]]]
"""entity_type -> entity_id -> fields"""

# Set by movement events only. A field_changed that names one is rejected.
DERIVED_FIELDS = frozenset({"status", "holder_id", "since", "notes", "conflicts"})
MOVEMENTS = frozenset({"checked_out", "checked_in"})


class UnknownEventType(ValueError):
    pass


def replay(events: Iterable[Event]) -> State:
    """Build state from scratch. Input order does not matter; replay order does."""
    state: State = {}
    last_movement: dict[tuple[str, str], Event] = {}
    for event in sorted(events, key=lambda e: (e.effective_at, e.device_id, e.device_seq)):
        key = (event.entity_type, event.entity_id)
        entity = state.setdefault(event.entity_type, {}).setdefault(event.entity_id, {})
        apply(entity, event, last_movement.get(key))
        if event.type in MOVEMENTS:
            last_movement[key] = event
    return state


def apply(entity: dict[str, Any], event: Event, last_movement: Event | None = None) -> None:
    """One event onto one entity's fields, in place.

    last_movement is the item's previous check-out or check-in in replay
    order, or None. It is what makes a double check-out detectable.
    """
    p = event.payload
    match event.type:
        case "created":
            entity.update(p)
            if event.entity_type == "item":
                entity.setdefault("status", "in")
                entity.setdefault("holder_id", None)
        case "field_changed":
            entity[p["field"]] = p["value"]
        case "note_added":
            entity.setdefault("notes", []).append(
                {"id": event.id, "text": p["text"], "actor_id": event.actor_id, "at": event.effective_at}
            )
        case "note_corrected":
            # The original event stands in the log; only the rendered text moves.
            for note in entity.get("notes", []):
                if note["id"] == p["note_id"]:
                    note["text"] = p["text"]
        case "checked_out":
            # Two check-outs from different devices with no check-in between:
            # the machine picks the later one and queues both (FR-OFF-10).
            if (
                last_movement is not None
                and last_movement.type == "checked_out"
                and last_movement.device_id != event.device_id
            ):
                entity.setdefault("conflicts", []).append(
                    {"kind": "double_checkout", "events": [_movement(last_movement), _movement(event)]}
                )
            entity["status"] = "out"
            entity["holder_id"] = p["holder_id"]
            entity["since"] = event.effective_at
        case "checked_in":
            entity["status"] = "in"
            entity["holder_id"] = None
            entity["since"] = event.effective_at
        case other:
            raise UnknownEventType(other)


def _movement(event: Event) -> dict[str, Any]:
    return {
        "id": event.id,
        "holder_id": event.payload.get("holder_id"),
        "actor_id": event.actor_id,
        "device_id": event.device_id,
        "at": event.effective_at,
    }
