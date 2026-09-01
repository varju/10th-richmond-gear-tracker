"""Replay: events in, current state out. Pure.

This runs twice, here and in TypeScript on the device, and the two must agree.
The shared vectors under vectors/replay/ are the contract (NFR-MAINT-04). Change
the rules here, change the vectors, and the other side fails until it catches up.
"""

from __future__ import annotations

import copy
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from gear_tracker.events import Event

State = dict[str, dict[str, dict[str, Any]]]
"""entity_type -> entity_id -> fields"""

# Set by movement events only. A field_changed that names one is rejected.
DERIVED_FIELDS = frozenset({"status", "holder_id", "since", "movement", "notes", "conflicts"})


class UnknownEventType(ValueError):
    pass


def replay(events: Iterable[Event], base: State | None = None) -> State:
    """Build state, from scratch or on top of a snapshot. Input order does not matter; replay order does.

    A device holds a snapshot plus the events after it (FR-OFF-14), so everything
    replay needs to continue from must be in the state itself. That is why an
    item carries its last `movement`.
    """
    state: State = copy.deepcopy(base) if base else {}
    for event in sorted(events, key=lambda e: (e.effective_at, e.device_id, e.device_seq)):
        entity = state.setdefault(event.entity_type, {}).setdefault(event.entity_id, {})
        apply(entity, event)
    return state


def apply(entity: dict[str, Any], event: Event) -> None:
    """One event onto one entity's fields, in place."""
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
            previous = entity.get("movement")
            if previous is not None and previous["type"] == "checked_out" and previous["device_id"] != event.device_id:
                entity.setdefault("conflicts", []).append(
                    {"kind": "double_checkout", "events": [previous, _movement(event)]}
                )
            entity["status"] = "out"
            entity["holder_id"] = p["holder_id"]
            entity["since"] = event.effective_at
            entity["movement"] = _movement(event)
        case "checked_in":
            entity["status"] = "in"
            entity["holder_id"] = None
            entity["since"] = event.effective_at
            entity["movement"] = _movement(event)
        case other:
            raise UnknownEventType(other)


def _movement(event: Event) -> dict[str, Any]:
    return {
        "id": event.id,
        "type": event.type,
        "holder_id": event.payload.get("holder_id"),
        "actor_id": event.actor_id,
        "device_id": event.device_id,
        "at": event.effective_at,
    }
