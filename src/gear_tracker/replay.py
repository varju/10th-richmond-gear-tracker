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

# --- pools (FR-INV-34) -----------------------------------------------------------------------
#
# A pool is an item with `generic: true` and `pool: true`, `created` with an integer `quantity`
# (>= 0). It has no code and no units (sync.py refuses both). Its `status` stays "in" and
# `holder_id` null forever; the counts below carry the truth. Owned is `pool_in` plus the sum
# of every count in `pool_out`; it is never stored.
#
# Derived fields, in DERIVED_FIELDS so a device cannot set them directly:
#   pool_in   int            what is on the shelf right now
#   pool_out  {holder_id: int > 0}   what each holder has; a holder back at zero is removed
#
# Events, on the pool's own entity (mirrored in inventory.ts's `poolCounts`, `isPool`):
#   created    {quantity}                    pool_in = quantity, pool_out = {}
#   checked_out {holder_id, count, event?}   pool_out[holder_id] += count; pool_in -= count,
#                                             clamped at 0 (an overdraw warns, never blocks:
#                                             FR-OUT-22). No supersedes, no conflict rule: counts
#                                             from any device just add, whatever the order
#                                             (FR-OUT-24).
#   checked_in  {holder_id?, count}          holder defaults to the actor; pool_out[holder] =
#                                             max(0, pool_out[holder] - count), removed at 0;
#                                             pool_in += count (FR-OUT-23).
#   recounted   {count, reason}              pool_in = count. pool_out is untouched (FR-INV-35);
#                                             anyone signed in may record one.
#
# A pool's `movement` is kept up to date like any item's, with `count` added (see `_movement`),
# so the item's History can read "Alice checked out 10" straight off the log.

# Set by replay, never by a device. A created or field_changed that names one is rejected.
DERIVED_FIELDS = frozenset(
    {
        "status",
        "holder_id",
        "since",
        "movement",
        "notes",
        "conflicts",
        "added_at",
        "modified_at",
        "item_id",
        "bound_at",
        "photos",
        "raised_by",
        "pool_in",
        "pool_out",
    }
)


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
            entity["added_at"] = event.effective_at
            entity["modified_at"] = event.effective_at
            # A generic item is a name several things share; it never moves, so it has no status (FR-INV-21).
            if event.entity_type == "item" and not p.get("generic"):
                entity.setdefault("status", "in")
                entity.setdefault("holder_id", None)
            # A pool is a generic too, but it stays "in" and unheld forever; the counts carry the truth (FR-INV-34).
            if event.entity_type == "item" and p.get("pool"):
                entity.setdefault("status", "in")
                entity.setdefault("holder_id", None)
                entity["pool_in"] = p.get("quantity", 0)
                entity["pool_out"] = {}
            if event.entity_type == "repair":
                entity["raised_by"] = event.actor_id
                entity.setdefault("state", "open")
        case "field_changed":
            # Modified means the entity's own fields (FR-INV-03). Movements and notes do not count.
            entity[p["field"]] = p["value"]
            entity["modified_at"] = event.effective_at
        case "item_added":
            # The gear list is edited one line at a time, so two devices adding an
            # extra offline both land (FR-RES-07). A new list each time: the one
            # `created` put here is the event's own payload.
            items = entity.get("items", [])
            if p["item_id"] not in items:
                entity["items"] = [*items, p["item_id"]]
            entity["modified_at"] = event.effective_at
        case "item_removed":
            entity["items"] = [i for i in entity.get("items", []) if i != p["item_id"]]
            entity["modified_at"] = event.effective_at
        case "quantity_changed":
            # How many of a generic the reservation wants (FR-RES-13). Zero drops the line.
            lines = entity.get("generics", [])
            item_id, quantity = p["item_id"], p["quantity"]
            if quantity == 0:
                entity["generics"] = [g for g in lines if g["item_id"] != item_id]
            elif any(g["item_id"] == item_id for g in lines):
                entity["generics"] = [{**g, "quantity": quantity} if g["item_id"] == item_id else g for g in lines]
            else:
                entity["generics"] = [*lines, {"item_id": item_id, "quantity": quantity}]
            entity["modified_at"] = event.effective_at
        case "event_corrected":
            # The movement stands in the log; only the event it is read under moves
            # (FR-RES-17, as FR-OUT-16). Older movements are corrected in the log
            # too; state carries the last one, which is what "out under" means.
            movement = entity.get("movement")
            if movement is not None and movement["id"] == p["movement_id"]:
                movement["event"] = p.get("event")
        case "note_added":
            note = {"id": event.id, "text": p["text"], "actor_id": event.actor_id, "at": event.effective_at}
            if p.get("movement_id") is not None:
                note["movement_id"] = p["movement_id"]
            entity.setdefault("notes", []).append(note)
        case "note_corrected":
            # The original event stands in the log; only the rendered text moves.
            for note in entity.get("notes", []):
                if note["id"] == p["note_id"]:
                    note["text"] = p["text"]
        case "note_deleted":
            # The note stops being shown; the log keeps it, with who wrote it and when (FR-OUT-21).
            entity["notes"] = [n for n in entity.get("notes", []) if n["id"] != p["note_id"]]
        case "checked_out":
            if p.get("count") is not None:
                # A pool moves by count, not by holder (FR-OUT-22): several people may have some out at
                # once, counts from any device just add, and there is no conflict rule (FR-OUT-24).
                pool_out = dict(entity.get("pool_out", {}))
                pool_out[p["holder_id"]] = pool_out.get(p["holder_id"], 0) + p["count"]
                entity["pool_out"] = pool_out
                entity["pool_in"] = max(0, entity.get("pool_in", 0) - p["count"])
                entity["movement"] = _movement(event)
            else:
                # Two check-outs from different devices with no check-in between:
                # the machine picks the later one and queues both (FR-OFF-10).
                # Unless the later one says which check-out it replaces: that is a
                # transfer, made by someone who saw the first (FR-OUT-12).
                previous = entity.get("movement")
                if (
                    previous is not None
                    and previous["type"] == "checked_out"
                    and previous["device_id"] != event.device_id
                    and p.get("supersedes") != previous["id"]
                ):
                    entity.setdefault("conflicts", []).append(
                        {"kind": "double_checkout", "events": [previous, _movement(event)]}
                    )
                entity["status"] = "out"
                entity["holder_id"] = p["holder_id"]
                entity["since"] = event.effective_at
                entity["movement"] = _movement(event)
        case "checked_in":
            if p.get("count") is not None:
                # The count offered is what the holder has out; returning fewer leaves the rest against
                # them (FR-OUT-23). The holder defaults to whoever is returning it.
                holder_id = p.get("holder_id") or event.actor_id
                pool_out = dict(entity.get("pool_out", {}))
                remaining = max(0, pool_out.get(holder_id, 0) - p["count"])
                if remaining:
                    pool_out[holder_id] = remaining
                else:
                    pool_out.pop(holder_id, None)
                entity["pool_out"] = pool_out
                entity["pool_in"] = entity.get("pool_in", 0) + p["count"]
                movement = _movement(event)
                movement["holder_id"] = holder_id
                entity["movement"] = movement
            else:
                entity["status"] = "in"
                entity["holder_id"] = None
                entity["since"] = event.effective_at
                entity["movement"] = _movement(event)
        case "recounted":
            # How many are in right now; what is already out is untouched (FR-INV-35).
            entity["pool_in"] = p["count"]
        case "photo_added":
            # The file is on the server; this is what a device knows about it (FR-INV-11).
            entity.setdefault("photos", []).append(
                {
                    "id": p["photo_id"],
                    "content_type": p["content_type"],
                    "size": p["size"],
                    "actor_id": event.actor_id,
                    "at": event.effective_at,
                }
            )
        case "photo_removed":
            # The file stays on disk; the log says it is no longer shown.
            entity["photos"] = [ph for ph in entity.get("photos", []) if ph["id"] != p["photo_id"]]
        case "code_bound":
            # A code binds once. Whether it is the item's current code or a replaced
            # one is a question about the item's other codes, answered by whoever asks.
            entity["item_id"] = p["item_id"]
            entity["bound_at"] = event.effective_at
        case "code_released":
            # Deliberate, unlike a replace (FR-TAG-05): the code goes back to
            # unassigned, so scanning it offers a new item or a bind (FR-TAG-07).
            entity["item_id"] = None
        case other:
            raise UnknownEventType(other)


def _movement(event: Event) -> dict[str, Any]:
    m = {
        "id": event.id,
        "type": event.type,
        "holder_id": event.payload.get("holder_id"),
        "event": event.payload.get("event"),
        "actor_id": event.actor_id,
        "device_id": event.device_id,
        "at": event.effective_at,
    }
    if event.payload.get("count") is not None:
        m["count"] = event.payload["count"]
    return m
