"""Replay: events in, current state out. Pure.

This runs twice, here and in TypeScript on the device, and the two must agree.
The shared vectors under vectors/replay/ are the contract (NFR-MAINT-04). Change
the rules here, change the vectors, and the other side fails until it catches up.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from gear_tracker.events import Event

State = dict[str, dict[str, dict[str, Any]]]
"""entity_type -> entity_id -> fields"""

# --- pools (FR-INV-34) -----------------------------------------------------------------------
#
# A pool is an item with `generic: true` and `pool: true`, `created` with an integer `quantity`
# (>= 0). It has no units (sync.py refuses that); it may carry a code, bound to the container that
# holds the stack rather than to a labelled unit (FR-TAG-15). Its `status` stays "in" and
# `holder_id` null forever; the counts below carry the truth. Owned is `pool_in` plus the sum
# of every count in `pool_out`; it is never stored.
#
# Derived fields, in DERIVED_FIELDS so a device cannot set them directly:
#   pool_in          int                          what is on the shelf right now
#   pool_out         {holder_id: int > 0}         what each holder has; a holder back at zero is removed
#   pool_lots        {holder_id: [lot]}           which check-outs each holder's count came from, oldest first:
#                                                  {id, count, event, reservation_id, at, cleaner?, cleaning_id?}
#                                                  Lot ids are unique. `cleaning_id` is the cleaning_started that
#                                                  sent the lot home; one send-home can span several lots.
#   pool_reservations {reservation_id: int > 0}   how many went out for each reservation, ever
#                                                  (FR-RES-13). A checked_out that carries a
#                                                  reservation_id adds to it, event_corrected moves a
#                                                  lot's count, and a return never reduces it. Older app
#                                                  builds read it for progress; this one counts the lots
#                                                  (views.pool_packed), so it is kept for them only. Keyed
#                                                  by reservation id, not by event name, so a later
#                                                  reservation reusing an event name starts at zero.
#
# Events, on the pool's own entity (mirrored in inventory.ts's `poolCounts`, `isPool`):
#   created    {quantity}                            pool_in = quantity, pool_out = {}, pool_reservations = {}
#   checked_out {holder_id, count, event?,           pool_out[holder_id] += count; pool_in -= count,
#                reservation_id?}                     clamped at 0 (an overdraw warns, never blocks:
#                                                      FR-OUT-22). No supersedes, no conflict rule: counts
#                                                      from any device just add, whatever the order
#                                                      (FR-OUT-24). A reservation_id also adds count to
#                                                      pool_reservations[reservation_id]; with none, it
#                                                      adds to nothing.
#   checked_in  {holder_id?, count}          holder defaults to the actor; pool_out[holder] =
#                                             max(0, pool_out[holder] - count), removed at 0;
#                                             pool_in += count (FR-OUT-23). A return says nothing of
#                                             which event, so it comes off the holder's oldest lots.
#   event_corrected {movement_id, event?,    a lot from that check-out moves to the new event, and its
#                    reservation_id?}         count moves between pool_reservations entries.
#   cleaner_corrected {movement_id, cleaner}  every lot, and the item's movement, that still has a cleaner and
#                                             whose `cleaning_id`, else `id`, is `movement_id` takes the new
#                                             cleaner. Gear that has come back is ignored. A checked_out with
#                                             a cleaner adds it to its lot; a checked_in with one comes off
#                                             that cleaner's lots first (return_lots).
#   cleaning_ended {cleaner?, count?,         cleaned gear is back with its Scouter (FR-OUT-51). A single
#                   holder_id?}                item's movement loses its cleaner and cleaning_id. A pool's `count` of
#                                             that holder's lots under `cleaner` lose it (end_cleaning).
#                                             Counts and holders do not change.
#   cleaning_started {cleaner, count?,        `count` of that holder's lots not at a cleaner go home with
#                     holder_id?,              `cleaner` (FR-OUT-46); counts, holders and events do not change
#                     movement_id?}            (start_cleaning). With no `count`, a single item that is out
#                                              takes `cleaner` and `cleaning_id` on its movement if that
#                                              movement is `movement_id`; its holder, event, reservation and
#                                              `since` stay. Otherwise ignored.
#   checked_out superseding a movement that has a cleaner, with none of its own, keeps that cleaner and
#   `cleaning_id` (a transfer of gear at a cleaner's, FR-OUT-46).
#   recounted   {count, reason?}             pool_in = count. pool_out is untouched (FR-INV-35);
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
        "created_by",
        "pool_in",
        "pool_out",
        "pool_reservations",
        "pool_lots",
        "deactivated_at",
    }
)


class UnknownEventType(ValueError):
    pass


def keep_newest(lots: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    """The newest lots that add up to `count`: a return comes off the oldest. Mirrors keepNewest in replay.ts."""
    kept: list[dict[str, Any]] = []
    left = count
    for lot in reversed(lots):
        if left <= 0:
            break
        n = min(lot["count"], left)
        kept.insert(0, {**lot, "count": n})
        left -= n
    return kept


def cleaner_key(name: str) -> str:
    """What makes two cleaner names the same: case and spacing aside. Mirrors cleanerKey in replay.ts."""
    return " ".join(part for part in re.split(r"[ \t\n\r]+", name) if part).lower()


def return_lots(lots: list[dict[str, Any]], before: int, count: int, cleaner: str | None) -> list[dict[str, Any]]:
    """A holder's lots after `count` of their `before` are returned (FR-OUT-47). Mirrors returnLots in replay.ts.

    A return naming a cleaner comes off that cleaner's lots first. What is left to take, and any return that
    names nobody, comes off the part no lot explains, then the ordinary lots, then the cleaning lots: each
    oldest first, so a plain return never swallows a family's lot.
    """
    left = min(count, before)
    kept = [dict(lot) for lot in lots]

    def take(match: Any) -> None:
        nonlocal left
        for lot in kept:
            if left > 0 and match(lot):
                n = min(lot["count"], left)
                lot["count"] -= n
                left -= n

    if cleaner:
        key = cleaner_key(cleaner)
        take(lambda lot: bool(lot.get("cleaner")) and cleaner_key(lot["cleaner"]) == key)
    left -= min(left, max(0, before - sum(lot["count"] for lot in lots)))
    take(lambda lot: not lot.get("cleaner"))
    take(lambda lot: True)
    return [lot for lot in kept if lot["count"] > 0]


def end_cleaning(lots: list[dict[str, Any]], count: int, cleaner: str | None, new_id: str) -> list[dict[str, Any]]:
    """A holder's lots after `count` of those under `cleaner` come back (FR-OUT-51). Mirrors endCleaning in replay.ts.

    Oldest first. A lot that comes back whole keeps its id; a part of one takes `new_id`, and the rest stays
    with its cleaner and its `cleaning_id`.
    """
    if not cleaner:
        return [dict(lot) for lot in lots]
    key = cleaner_key(cleaner)
    left = count
    out: list[dict[str, Any]] = []
    for lot in lots:
        if left > 0 and lot.get("cleaner") and cleaner_key(lot["cleaner"]) == key:
            n = min(lot["count"], left)
            left -= n
            back = {k: v for k, v in lot.items() if k not in ("cleaner", "cleaning_id")}
            if n == lot["count"]:
                out.append(back)
            else:
                out.append({**lot, "count": lot["count"] - n})
                out.append({**back, "id": new_id, "count": n})
        else:
            out.append(dict(lot))
    return out


def start_cleaning(lots: list[dict[str, Any]], count: int, cleaner: str, new_id: str) -> list[dict[str, Any]]:
    """A holder's lots after `count` of those not yet at a cleaner go home with `cleaner` (FR-OUT-46).
    Mirrors startCleaning in replay.ts. Oldest first. Every lot that goes gets `cleaning_id` `new_id`, so a
    later correction of the name, which names this event, finds them all. A lot that goes whole keeps its
    id; a part of one takes `new_id`, so lot ids stay unique.
    """
    left = count
    out: list[dict[str, Any]] = []
    for lot in lots:
        if left > 0 and not lot.get("cleaner"):
            n = min(lot["count"], left)
            left -= n
            if n == lot["count"]:
                out.append({**lot, "cleaner": cleaner, "cleaning_id": new_id})
            else:
                out.append({**lot, "count": lot["count"] - n})
                out.append({**lot, "id": new_id, "count": n, "cleaner": cleaner, "cleaning_id": new_id})
        else:
            out.append(dict(lot))
    return out


def _names(thing: dict[str, Any], movement_id: str) -> bool:
    return (thing.get("cleaning_id") or thing["id"]) == movement_id


def _correct_cleaner(entity: dict[str, Any], p: dict[str, Any]) -> None:
    for lots in (entity.get("pool_lots") or {}).values():
        for lot in lots:
            if lot.get("cleaner") and _names(lot, p["movement_id"]):
                lot["cleaner"] = p["cleaner"]


def _correct_lot(entity: dict[str, Any], p: dict[str, Any]) -> None:
    next_id = p.get("reservation_id")
    for lots in (entity.get("pool_lots") or {}).values():
        for lot in lots:
            if lot["id"] != p["movement_id"]:
                continue
            if lot["reservation_id"] != next_id:
                totals = dict(entity.get("pool_reservations", {}))
                if lot["reservation_id"] is not None:
                    left = totals.get(lot["reservation_id"], 0) - lot["count"]
                    if left > 0:
                        totals[lot["reservation_id"]] = left
                    else:
                        totals.pop(lot["reservation_id"], None)
                if next_id is not None:
                    totals[next_id] = totals.get(next_id, 0) + lot["count"]
                entity["pool_reservations"] = totals
            lot["event"] = p.get("event")
            lot["reservation_id"] = next_id
            return


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
                entity["pool_in"] = p.get("quantity") or 0
                entity["pool_out"] = {}
                entity["pool_reservations"] = {}
            if event.entity_type == "repair":
                entity["raised_by"] = event.actor_id
                entity.setdefault("state", "open")
            if event.entity_type == "reservation":
                entity["created_by"] = event.actor_id
        case "field_changed":
            # Modified means the entity's own fields (FR-INV-03). Movements and notes do not count.
            entity[p["field"]] = p["value"]
            entity["modified_at"] = event.effective_at
            # When a user is deactivated, remember when (FR-USR-20); a reactivation clears it.
            if event.entity_type == "user" and p["field"] == "active":
                entity["deactivated_at"] = event.effective_at if p["value"] is False else None
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
                movement["reservation_id"] = p.get("reservation_id")
            _correct_lot(entity, p)
        case "cleaner_corrected":
            # As event_corrected: the check-out stands; only the name it is read under moves (FR-OUT-50).
            # Gear that has come back has no cleaner to correct.
            movement = entity.get("movement")
            if movement is not None and movement.get("cleaner") and _names(movement, p["movement_id"]):
                movement["cleaner"] = p["cleaner"]
            _correct_cleaner(entity, p)
        case "cleaning_started":
            if p.get("count") is None:
                # Still out to the same holder under the check-out it names; only the cleaner is added.
                movement = entity.get("movement")
                if entity.get("status") == "out" and movement is not None and movement["id"] == p.get("movement_id"):
                    movement["cleaner"] = p["cleaner"]
                    movement["cleaning_id"] = event.id
                return
            holder_id = p.get("holder_id") or event.actor_id
            lots = dict(entity.get("pool_lots", {}))
            if holder_id in lots:
                lots[holder_id] = start_cleaning(lots[holder_id], p["count"], p["cleaner"], event.id)
                entity["pool_lots"] = lots
        case "cleaning_ended":
            if p.get("count") is not None:
                holder_id = p.get("holder_id") or event.actor_id
                lots = dict(entity.get("pool_lots", {}))
                if holder_id in lots:
                    lots[holder_id] = end_cleaning(lots[holder_id], p["count"], p.get("cleaner"), event.id)
                    entity["pool_lots"] = lots
            else:
                movement = entity.get("movement")
                if entity.get("status") == "out" and movement is not None:
                    movement.pop("cleaner", None)
                    movement.pop("cleaning_id", None)
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
                if p.get("reservation_id") is not None:
                    pool_reservations = dict(entity.get("pool_reservations", {}))
                    pool_reservations[p["reservation_id"]] = pool_reservations.get(p["reservation_id"], 0) + p["count"]
                    entity["pool_reservations"] = pool_reservations
                lots = dict(entity.get("pool_lots", {}))
                lot = {
                    "id": event.id,
                    "count": p["count"],
                    "event": p.get("event"),
                    "reservation_id": p.get("reservation_id"),
                    "at": event.effective_at,
                }
                if p.get("cleaner"):
                    lot["cleaner"] = p["cleaner"]
                lots[p["holder_id"]] = [*lots.get(p["holder_id"], []), lot]
                entity["pool_lots"] = lots
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
                # A transfer made without seeing the send-home keeps the gear at the cleaner's.
                if (
                    previous is not None
                    and previous.get("cleaner")
                    and p.get("supersedes") == previous["id"]
                    and not p.get("cleaner")
                ):
                    entity["movement"]["cleaner"] = previous["cleaner"]
                    entity["movement"]["cleaning_id"] = previous.get("cleaning_id") or previous["id"]
        case "checked_in":
            if p.get("count") is not None:
                # The count offered is what the holder has out; returning fewer leaves the rest against
                # them (FR-OUT-23). The holder defaults to whoever is returning it.
                holder_id = p.get("holder_id") or event.actor_id
                pool_out = dict(entity.get("pool_out", {}))
                before = pool_out.get(holder_id, 0)
                remaining = max(0, before - p["count"])
                if remaining:
                    pool_out[holder_id] = remaining
                else:
                    pool_out.pop(holder_id, None)
                entity["pool_out"] = pool_out
                entity["pool_in"] = entity.get("pool_in", 0) + p["count"]
                lots = dict(entity.get("pool_lots", {}))
                if remaining:
                    lots[holder_id] = return_lots(lots.get(holder_id, []), before, p["count"], p.get("cleaner"))
                else:
                    lots.pop(holder_id, None)
                entity["pool_lots"] = lots
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
        "reservation_id": event.payload.get("reservation_id"),
        "actor_id": event.actor_id,
        "device_id": event.device_id,
        "at": event.effective_at,
    }
    if event.payload.get("count") is not None:
        m["count"] = event.payload["count"]
    if event.payload.get("cleaner"):
        m["cleaner"] = event.payload["cleaner"]
    return m
