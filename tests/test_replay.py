"""Replay is pure. These are the Python-side rules; vectors/ is the shared contract."""

from __future__ import annotations

import random
from typing import Any

import pytest

from gear_tracker.events import Event
from gear_tracker.replay import UnknownEventType, replay
from gear_tracker.ulid import new_ulid
from tests.factories import T0


def ev(**overrides: Any) -> Event:
    fields: dict[str, Any] = {
        "id": new_ulid(),
        "entity_type": "item",
        "entity_id": "tent-1",
        "type": "field_changed",
        "actor_id": "alice",
        "device_id": "a",
        "device_seq": 1,
        "occurred_at": T0,
        "clock_offset": 0,
        "effective_at": T0,
        "received_at": T0,
        "seq": 0,
        "payload": {"field": "name", "value": "Tent"},
    }
    fields.update(overrides)
    return Event(**fields)


def test_empty_log_is_empty_state():
    assert replay([]) == {}


def test_created_then_changed():
    state = replay(
        [
            ev(device_seq=1, type="created", payload={"name": "Tent", "category": "shelter"}),
            ev(device_seq=2, effective_at=T0 + 1, payload={"field": "name", "value": "Tent, 4 person"}),
        ]
    )
    assert state == {
        "item": {
            "tent-1": {
                "name": "Tent, 4 person",
                "category": "shelter",
                "status": "in",
                "holder_id": None,
                "added_at": T0,
                "modified_at": T0 + 1,
            }
        }
    }


def test_only_items_get_movement_defaults():
    state = replay([ev(entity_type="user", entity_id="alice", type="created", payload={"name": "Alice"})])
    assert state["user"]["alice"] == {"name": "Alice", "added_at": T0, "modified_at": T0}


def test_an_entity_can_exist_without_a_created_event():
    """Field edits are merges, so whichever arrives first still leaves the right answer."""
    state = replay([ev(payload={"field": "name", "value": "Tent"})])
    assert state["item"]["tent-1"] == {"name": "Tent", "modified_at": T0}


def test_movements_and_notes_do_not_count_as_modification():
    out = ev(device_seq=2, effective_at=T0 + 5, type="checked_out", payload={"holder_id": "bob"})
    note = ev(device_seq=3, effective_at=T0 + 6, type="note_added", payload={"text": "muddy"})
    state = replay([ev(device_seq=1, type="created", payload={"name": "Tent"}), out, note])
    assert state["item"]["tent-1"]["modified_at"] == T0


def test_code_bound_records_the_item_and_when():
    bound = ev(entity_type="code", entity_id="ABCDEFGH23", type="code_bound", payload={"item_id": "tent-1"})
    state = replay([ev(entity_type="code", entity_id="ABCDEFGH23", type="created", payload={}), bound])
    assert state["code"]["ABCDEFGH23"] == {"item_id": "tent-1", "bound_at": T0, "added_at": T0, "modified_at": T0}


def test_code_released_clears_the_item_but_keeps_bound_at():
    bound = ev(
        entity_type="code",
        entity_id="ABCDEFGH23",
        device_seq=2,
        effective_at=T0 + 1,
        type="code_bound",
        payload={"item_id": "tent-1"},
    )
    released = ev(
        entity_type="code",
        entity_id="ABCDEFGH23",
        device_seq=3,
        effective_at=T0 + 2,
        type="code_released",
        payload={},
    )
    state = replay([ev(entity_type="code", entity_id="ABCDEFGH23", type="created", payload={}), bound, released])
    assert state["code"]["ABCDEFGH23"] == {
        "item_id": None,
        "bound_at": T0 + 1,
        "added_at": T0,
        "modified_at": T0,
    }


def test_a_released_code_binds_again_onto_a_new_item():
    events = [
        ev(entity_type="code", entity_id="ABCDEFGH23", device_seq=1, type="created", payload={}),
        ev(
            entity_type="code",
            entity_id="ABCDEFGH23",
            device_seq=2,
            effective_at=T0 + 1,
            type="code_bound",
            payload={"item_id": "tent-1"},
        ),
        ev(
            entity_type="code",
            entity_id="ABCDEFGH23",
            device_seq=3,
            effective_at=T0 + 2,
            type="code_released",
            payload={},
        ),
        ev(
            entity_type="code",
            entity_id="ABCDEFGH23",
            device_seq=4,
            effective_at=T0 + 3,
            type="code_bound",
            payload={"item_id": "tent-2"},
        ),
    ]
    state = replay(events)
    assert state["code"]["ABCDEFGH23"]["item_id"] == "tent-2"
    assert state["code"]["ABCDEFGH23"]["bound_at"] == T0 + 3


def test_replay_order_beats_input_order():
    events = [
        ev(device_seq=1, effective_at=T0 + 1, payload={"field": "name", "value": "first"}),
        ev(device_seq=2, effective_at=T0 + 2, payload={"field": "name", "value": "second"}),
        ev(device_seq=3, effective_at=T0 + 3, payload={"field": "name", "value": "third"}),
    ]
    shuffled = events[:]
    random.Random(0).shuffle(shuffled)
    assert shuffled != events

    assert replay(shuffled)["item"]["tent-1"]["name"] == "third"


def test_ties_break_on_device_then_device_seq():
    events = [
        ev(device_id="b", device_seq=1, payload={"field": "name", "value": "b1"}),
        ev(device_id="a", device_seq=2, payload={"field": "name", "value": "a2"}),
        ev(device_id="a", device_seq=1, payload={"field": "name", "value": "a1"}),
    ]
    assert replay(events)["item"]["tent-1"]["name"] == "b1"


def test_check_out_then_in():
    out = ev(device_seq=1, effective_at=T0 + 1, type="checked_out", payload={"holder_id": "bob"})
    back = ev(device_seq=2, effective_at=T0 + 2, type="checked_in", payload={})

    after_out = replay([out])["item"]["tent-1"]
    assert (after_out["status"], after_out["holder_id"], after_out["since"]) == ("out", "bob", T0 + 1)
    assert after_out["movement"]["id"] == out.id

    after_in = replay([out, back])["item"]["tent-1"]
    assert (after_in["status"], after_in["holder_id"], after_in["since"]) == ("in", None, T0 + 2)
    assert after_in["movement"]["type"] == "checked_in"


def test_replay_continues_from_a_snapshot():
    out = ev(device_id="a", device_seq=1, effective_at=T0 + 1, type="checked_out", payload={"holder_id": "bob"})
    snapshot = replay([out])
    later = ev(device_id="b", device_seq=1, effective_at=T0 + 2, type="checked_out", payload={"holder_id": "carol"})

    incremental = replay([later], snapshot)
    assert incremental == replay([out, later]), "a snapshot plus the rest equals the whole log"
    assert snapshot["item"]["tent-1"]["holder_id"] == "bob", "the base is not mutated"


def test_a_late_arriving_check_in_does_not_undo_a_later_check_out():
    """A phone syncing Sunday delivers Friday's check-in; Saturday's check-out on another phone still stands."""
    friday_in = ev(device_id="slow", device_seq=1, effective_at=T0, type="checked_in", payload={})
    saturday_out = ev(
        device_id="fast", device_seq=1, effective_at=T0 + 86_400_000, type="checked_out", payload={"holder_id": "bob"}
    )
    state = replay([saturday_out, friday_in])["item"]["tent-1"]
    assert state["status"] == "out"
    assert state["holder_id"] == "bob"


def test_two_check_outs_from_different_devices_are_a_conflict():
    first = ev(device_id="a", device_seq=1, effective_at=T0 + 1, type="checked_out", payload={"holder_id": "bob"})
    second = ev(device_id="b", device_seq=1, effective_at=T0 + 2, type="checked_out", payload={"holder_id": "carol"})

    tent = replay([first, second])["item"]["tent-1"]
    assert tent["holder_id"] == "carol", "replay still picks an answer"
    assert tent["conflicts"] == [
        {
            "kind": "double_checkout",
            "events": [
                {
                    "id": first.id,
                    "type": "checked_out",
                    "holder_id": "bob",
                    "event": None,
                    "reservation_id": None,
                    "actor_id": "alice",
                    "device_id": "a",
                    "at": T0 + 1,
                },
                {
                    "id": second.id,
                    "type": "checked_out",
                    "holder_id": "carol",
                    "event": None,
                    "reservation_id": None,
                    "actor_id": "alice",
                    "device_id": "b",
                    "at": T0 + 2,
                },
            ],
        }
    ]


def test_two_check_outs_from_one_device_are_a_transfer_not_a_conflict():
    events = [
        ev(device_id="a", device_seq=1, effective_at=T0 + 1, type="checked_out", payload={"holder_id": "bob"}),
        ev(device_id="a", device_seq=2, effective_at=T0 + 2, type="checked_out", payload={"holder_id": "carol"}),
    ]
    assert "conflicts" not in replay(events)["item"]["tent-1"]


def test_a_check_out_that_names_the_one_it_replaces_is_a_transfer():
    first = ev(device_id="a", device_seq=1, effective_at=T0 + 1, type="checked_out", payload={"holder_id": "bob"})
    taken = ev(
        device_id="b",
        device_seq=1,
        effective_at=T0 + 2,
        type="checked_out",
        payload={"holder_id": "carol", "supersedes": first.id},
    )
    tent = replay([first, taken])["item"]["tent-1"]
    assert "conflicts" not in tent
    assert tent["holder_id"] == "carol"


def test_a_movement_carries_its_event_and_a_note_can_point_at_it():
    out = ev(device_seq=1, type="checked_out", payload={"holder_id": "bob", "event": "Spring camp"})
    note = ev(
        device_seq=2, effective_at=T0 + 1, type="note_added", payload={"text": "to a patrol", "movement_id": out.id}
    )
    tent = replay([out, note])["item"]["tent-1"]
    assert tent["movement"]["event"] == "Spring camp"
    assert tent["notes"] == [
        {"id": note.id, "text": "to a patrol", "actor_id": "alice", "at": T0 + 1, "movement_id": out.id}
    ]


def test_a_check_in_between_two_check_outs_is_not_a_conflict():
    events = [
        ev(device_id="a", device_seq=1, effective_at=T0 + 1, type="checked_out", payload={"holder_id": "bob"}),
        ev(device_id="c", device_seq=1, effective_at=T0 + 2, type="checked_in", payload={}),
        ev(device_id="b", device_seq=1, effective_at=T0 + 3, type="checked_out", payload={"holder_id": "carol"}),
    ]
    assert "conflicts" not in replay(events)["item"]["tent-1"]


def test_conflicts_are_per_item():
    events = [
        ev(
            entity_id="tent-1",
            device_id="a",
            device_seq=1,
            effective_at=T0 + 1,
            type="checked_out",
            payload={"holder_id": "bob"},
        ),
        ev(
            entity_id="tent-2",
            device_id="b",
            device_seq=1,
            effective_at=T0 + 2,
            type="checked_out",
            payload={"holder_id": "carol"},
        ),
    ]
    state = replay(events)["item"]
    assert "conflicts" not in state["tent-1"]
    assert "conflicts" not in state["tent-2"]


def test_notes_are_appended_and_corrected_in_place():
    first = ev(device_seq=1, effective_at=T0 + 1, type="note_added", payload={"text": "pole bent"})
    second = ev(device_seq=2, effective_at=T0 + 2, type="note_added", payload={"text": "peg missing"})
    fix = ev(
        device_seq=3, effective_at=T0 + 3, type="note_corrected", payload={"note_id": first.id, "text": "pole snapped"}
    )

    notes = replay([first, second, fix])["item"]["tent-1"]["notes"]
    assert [n["text"] for n in notes] == ["pole snapped", "peg missing"]
    assert notes[0] == {"id": first.id, "text": "pole snapped", "actor_id": "alice", "at": T0 + 1}


def test_correcting_an_unknown_note_changes_nothing():
    state = replay([ev(type="note_corrected", payload={"note_id": new_ulid(), "text": "x"})])
    assert state["item"]["tent-1"] == {}


def test_a_gear_list_is_built_one_line_at_a_time():
    """Per-line events, so two phones each adding an extra offline both land (FR-RES-07)."""
    made = ev(
        entity_type="reservation",
        entity_id="res-1",
        device_seq=1,
        type="created",
        payload={"event": "Fall Camp", "starts": "2026-10-02", "ends": "2026-10-04", "items": ["tent-1"]},
    )
    line = lambda **kw: ev(entity_type="reservation", entity_id="res-1", **kw)  # noqa: E731
    state = replay(
        [
            made,
            line(device_seq=2, effective_at=T0 + 1, type="item_added", payload={"item_id": "stove-1"}),
            # The other phone, offline at the same moment.
            line(device_id="b", device_seq=1, effective_at=T0 + 1, type="item_added", payload={"item_id": "tarp-1"}),
            # Already there: no repeat.
            line(device_seq=3, effective_at=T0 + 2, type="item_added", payload={"item_id": "stove-1"}),
            line(device_seq=4, effective_at=T0 + 3, type="item_removed", payload={"item_id": "tent-1"}),
            line(device_seq=5, effective_at=T0 + 4, type="quantity_changed", payload={"item_id": "t", "quantity": 2}),
            line(device_seq=6, effective_at=T0 + 5, type="quantity_changed", payload={"item_id": "u", "quantity": 1}),
            line(device_seq=7, effective_at=T0 + 6, type="quantity_changed", payload={"item_id": "t", "quantity": 4}),
            line(device_seq=8, effective_at=T0 + 7, type="quantity_changed", payload={"item_id": "u", "quantity": 0}),
        ]
    )
    assert state["reservation"]["res-1"]["items"] == ["stove-1", "tarp-1"]
    # A line that changes keeps its place; zero drops it.
    assert state["reservation"]["res-1"]["generics"] == [{"item_id": "t", "quantity": 4}]
    assert state["reservation"]["res-1"]["modified_at"] == T0 + 7
    # The list `created` carried is the event's own payload, and replay must not have written on it.
    assert made.payload["items"] == ["tent-1"]


def test_a_movements_event_is_corrected_by_an_appended_record():
    """The check-out stands; the event it is read under moves (FR-RES-17, FR-OUT-16)."""
    out = ev(device_seq=1, type="checked_out", payload={"holder_id": "alice", "event": None})
    fix = ev(
        device_seq=2, effective_at=T0 + 1, type="event_corrected", payload={"movement_id": out.id, "event": "Fall Camp"}
    )
    again = ev(
        device_seq=3, effective_at=T0 + 2, type="event_corrected", payload={"movement_id": out.id, "event": "Cub camp"}
    )
    other = ev(
        device_seq=4, effective_at=T0 + 3, type="event_corrected", payload={"movement_id": new_ulid(), "event": "x"}
    )

    movement = replay([out, fix, again, other])["item"]["tent-1"]["movement"]
    assert movement["event"] == "Cub camp"
    assert movement["id"] == out.id and movement["type"] == "checked_out"
    # Correcting a movement the item never had changes nothing.
    assert replay([other])["item"]["tent-1"] == {}


def test_correcting_the_event_of_a_movement_that_is_no_longer_current_changes_nothing():
    """State carries the last movement only; that is what "out under" means."""
    out = ev(device_seq=1, type="checked_out", payload={"holder_id": "alice", "event": "Thursday"})
    back = ev(device_seq=2, effective_at=T0 + 1, type="checked_in", payload={})
    fix = ev(
        device_seq=3, effective_at=T0 + 2, type="event_corrected", payload={"movement_id": out.id, "event": "Fall Camp"}
    )

    state = replay([out, back, fix])["item"]["tent-1"]
    assert state["status"] == "in"
    assert state["movement"]["id"] == back.id


# --- pools (FR-INV-34) ---------------------------------------------------------------------
# The shared vectors under vectors/replay/pool_*.json cover the headline cases; these are the
# edge cases that are awkward to spell out as fixed-state vectors.


def test_a_pool_returning_everything_clears_the_holder():
    created = ev(
        entity_id="bowls", device_seq=1, type="created", payload={"generic": True, "pool": True, "quantity": 10}
    )
    out = ev(
        entity_id="bowls",
        device_seq=2,
        effective_at=T0 + 1,
        type="checked_out",
        payload={"holder_id": "bob", "count": 4},
    )
    back = ev(
        entity_id="bowls",
        device_seq=3,
        effective_at=T0 + 2,
        type="checked_in",
        payload={"holder_id": "bob", "count": 4},
    )
    bowls = replay([created, out, back])["item"]["bowls"]
    assert bowls["pool_out"] == {}
    assert bowls["pool_in"] == 10


def test_a_pool_return_with_no_holder_defaults_to_whoever_is_returning_it():
    created = ev(
        entity_id="bowls", device_seq=1, type="created", payload={"generic": True, "pool": True, "quantity": 10}
    )
    out = ev(
        entity_id="bowls",
        actor_id="bob",
        device_seq=2,
        effective_at=T0 + 1,
        type="checked_out",
        payload={"holder_id": "bob", "count": 4},
    )
    back = ev(
        entity_id="bowls", actor_id="bob", device_seq=3, effective_at=T0 + 2, type="checked_in", payload={"count": 4}
    )
    bowls = replay([created, out, back])["item"]["bowls"]
    assert bowls["pool_out"] == {}
    assert bowls["movement"]["holder_id"] == "bob"


def test_a_pool_has_no_conflict_rule():
    """Counts from different devices just add, whatever the order (FR-OUT-24); nothing is queued."""
    created = ev(
        entity_id="bowls", device_seq=1, type="created", payload={"generic": True, "pool": True, "quantity": 10}
    )
    a = ev(
        entity_id="bowls",
        device_id="a",
        device_seq=2,
        effective_at=T0 + 1,
        type="checked_out",
        payload={"holder_id": "bob", "count": 3},
    )
    b = ev(
        entity_id="bowls",
        device_id="b",
        device_seq=1,
        effective_at=T0 + 2,
        type="checked_out",
        payload={"holder_id": "carol", "count": 5},
    )
    bowls = replay([created, a, b])["item"]["bowls"]
    assert "conflicts" not in bowls
    assert bowls["pool_out"] == {"bob": 3, "carol": 5}


def test_unknown_event_type_is_an_error_not_a_skip():
    """Both replays must fail the same way, or one shows state the other does not."""
    with pytest.raises(UnknownEventType, match="teleported"):
        replay([ev(type="teleported", payload={})])
