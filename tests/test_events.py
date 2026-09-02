"""The log, against the real database."""

from __future__ import annotations

import sqlite3

import pytest

from gear_tracker.db import connect
from gear_tracker.events import ENTITY_TYPES, Rejected, append, get, in_replay_order, since, validate
from gear_tracker.ulid import new_ulid
from tests.factories import T0, incoming


def test_seq_is_assigned_on_insert_and_climbs(db):
    a = append(db, incoming(device_seq=1), received_at=T0)
    b = append(db, incoming(device_seq=2), received_at=T0)
    assert (a.seq, b.seq) == (1, 2)


def test_append_is_idempotent_on_id(db):
    e = incoming()
    first = append(db, e, received_at=T0)
    again = append(db, e, received_at=T0 + 60_000)

    assert again == first
    assert db.execute("SELECT count(*) FROM events").fetchone()[0] == 1


def test_a_retry_after_a_conflicting_device_seq_still_finds_its_row(db):
    """Idempotency is checked before device_seq, so a replayed batch never rejects its own events."""
    e1 = incoming(device_seq=1)
    e2 = incoming(device_seq=2)
    append(db, e1, received_at=T0)
    append(db, e2, received_at=T0)

    assert append(db, e1, received_at=T0).id == e1["id"]


def test_device_seq_must_climb(db):
    append(db, incoming(device_seq=5), received_at=T0)

    with pytest.raises(Rejected, match="not above the last seen, 5"):
        append(db, incoming(device_seq=5), received_at=T0)
    with pytest.raises(Rejected, match="not above"):
        append(db, incoming(device_seq=4), received_at=T0)
    # Gaps are allowed: a rejected event must not wedge the ones behind it (NFR-DATA-01).
    assert append(db, incoming(device_seq=9), received_at=T0).device_seq == 9


def test_device_seq_is_per_device(db):
    append(db, incoming(device_id="phone-a", device_seq=1), received_at=T0)
    assert append(db, incoming(device_id="phone-b", device_seq=1), received_at=T0).device_seq == 1


def test_a_rejection_leaves_the_database_untouched(db):
    with pytest.raises(Rejected):
        append(db, incoming(entity_type="spaceship"), received_at=T0)
    assert db.execute("SELECT count(*) FROM events").fetchone()[0] == 0
    assert not db.in_transaction


@pytest.mark.parametrize(
    ("field", "value", "reason"),
    [
        ("id", "not-a-ulid", "ULID"),
        ("entity_type", "spaceship", "entity_type"),
        ("entity_id", "", "entity_id"),
        ("type", "teleported", "does not match any of the expected tags"),
        ("actor_id", "", "actor_id"),
        ("device_id", None, "device_id"),
        ("device_seq", 0, "device_seq"),
        ("device_seq", "1", "device_seq"),
        ("device_seq", True, "device_seq"),
        ("occurred_at", "2025-09-01", "occurred_at"),
        ("clock_offset", 1.5, "clock_offset"),
        ("payload", [], "payload"),
    ],
)
def test_rejects_malformed_events(db, field, value, reason):
    with pytest.raises(Rejected, match=reason):
        append(db, incoming(**{field: value}), received_at=T0)


def test_movement_events_apply_only_to_items(db):
    with pytest.raises(Rejected, match="only to items"):
        append(
            db,
            incoming(entity_type="user", entity_id="alice", type="checked_out", payload={"holder_id": "bob"}),
            received_at=T0,
        )


def test_every_entity_type_is_on_the_log(db):
    # A note is the one event every entity takes; a field change is judged per entity.
    for n, entity_type in enumerate(sorted(ENTITY_TYPES), start=1):
        e = incoming(entity_type=entity_type, entity_id=f"{entity_type}-1", device_seq=n)
        e.update(type="note_added", payload={"text": "hello"})
        append(db, e, received_at=T0)
    types = {r["entity_type"] for r in db.execute("SELECT entity_type FROM events")}
    assert types == ENTITY_TYPES


def test_stored_row_round_trips(db):
    e = incoming(payload={"field": "name", "value": "Tent, 4 person", "old": "Tent", "note": None})
    stored = append(db, e, received_at=T0 + 5)

    assert get(db, e["id"]) == stored
    assert stored.payload == e["payload"]
    assert stored.received_at == T0 + 5
    assert stored.occurred_at == T0


# --- clamp wiring -----------------------------------------------------------


def test_effective_at_is_clamped_to_arrival(db):
    stored = append(db, incoming(occurred_at=T0 + 10_000), received_at=T0)
    assert stored.effective_at == T0
    assert stored.occurred_at == T0 + 10_000, "the raw reading is kept"


def test_effective_at_applies_the_offset(db):
    stored = append(db, incoming(occurred_at=T0, clock_offset=-3_000), received_at=T0)
    assert stored.effective_at == T0 - 3_000


def test_effective_at_never_precedes_the_devices_previous_event(db):
    first = append(db, incoming(device_seq=1, occurred_at=T0 + 1_000), received_at=T0 + 1_000)
    second = append(db, incoming(device_seq=2, occurred_at=T0), received_at=T0 + 2_000)

    assert second.effective_at == first.effective_at
    assert second.occurred_at == T0


def test_the_floor_is_the_same_devices_event_not_another_devices(db):
    append(db, incoming(device_id="phone-a", device_seq=1, occurred_at=T0 + 5_000), received_at=T0 + 5_000)
    other = append(db, incoming(device_id="phone-b", device_seq=1, occurred_at=T0), received_at=T0 + 5_000)
    assert other.effective_at == T0


# --- append-only -------------------------------------------------------------


def test_no_update_path_exists(db):
    append(db, incoming(), received_at=T0)
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        db.execute("UPDATE events SET payload = '{}'")


def test_no_delete_path_exists(db):
    append(db, incoming(), received_at=T0)
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        db.execute("DELETE FROM events")
    assert db.execute("SELECT count(*) FROM events").fetchone()[0] == 1


def test_seq_is_never_reused_even_if_a_row_could_vanish(db_path):
    """AUTOINCREMENT: the cursor outlives whatever happens to the rows."""
    with connect(db_path) as conn:
        assert "AUTOINCREMENT" in conn.execute("SELECT sql FROM sqlite_master WHERE name='events'").fetchone()[0]


# --- reading it back ----------------------------------------------------------


def test_replay_order_is_effective_at_then_device_then_device_seq(db):
    # Arrival order is deliberately not replay order.
    append(db, incoming(device_id="b", device_seq=1, occurred_at=T0 + 2), received_at=T0 + 10)
    append(db, incoming(device_id="a", device_seq=1, occurred_at=T0 + 2), received_at=T0 + 10)
    append(db, incoming(device_id="a", device_seq=2, occurred_at=T0 + 2), received_at=T0 + 10)
    append(db, incoming(device_id="c", device_seq=1, occurred_at=T0 + 1), received_at=T0 + 10)

    keys = [(e.device_id, e.device_seq) for e in in_replay_order(db)]
    assert keys == [("c", 1), ("a", 1), ("a", 2), ("b", 1)]


def test_replay_order_can_be_sliced_to_one_entity(db):
    append(db, incoming(entity_id="tent-1", device_seq=1), received_at=T0)
    append(db, incoming(entity_id="tent-2", device_seq=2), received_at=T0)
    append(db, incoming(entity_id="tent-1", device_seq=3), received_at=T0)

    assert [e.device_seq for e in in_replay_order(db, "item", "tent-1")] == [1, 3]


def test_since_is_a_cursor_over_seq(db):
    for n in range(1, 6):
        append(db, incoming(device_seq=n), received_at=T0)

    page = since(db, cursor=2, limit=2)
    assert [e.seq for e in page] == [3, 4]
    assert [e.seq for e in since(db, cursor=4)] == [5]
    assert since(db, cursor=5) == []


def test_seq_order_is_commit_order_not_time_order(db):
    """An event that arrives late with an early timestamp still lands after the cursor."""
    append(db, incoming(device_id="a", device_seq=1, occurred_at=T0 + 100), received_at=T0 + 100)
    late = append(db, incoming(device_id="b", device_seq=1, occurred_at=T0), received_at=T0 + 200)

    assert late.seq == 2
    assert [e.seq for e in since(db, cursor=1)] == [2]
    assert [e.seq for e in in_replay_order(db)] == [2, 1]


# --- shaped payloads: repairs, reservations, found reports -----------------------------------


def created(entity_type: str, payload: dict) -> dict:
    return incoming(entity_type=entity_type, entity_id=f"{entity_type}-1", type="created", payload=payload)


def test_a_repair_ticket_names_its_item_and_the_fault():
    validate(created("repair", {"item_id": "tent-1", "description": "zipper broken"}))
    with pytest.raises(Rejected, match="item_id: Field required"):
        validate(created("repair", {"description": "zipper broken"}))
    with pytest.raises(Rejected, match="description: String should have at least 1 character"):
        validate(created("repair", {"item_id": "tent-1", "description": ""}))


def test_a_repair_state_is_one_of_four():
    change = incoming(entity_type="repair", entity_id="rep-1", payload={"field": "state", "value": "open", "old": None})
    validate(change)
    change["payload"]["value"] = "fixed"
    with pytest.raises(Rejected, match="state must be one of open, in_progress, resolved, wont_fix"):
        validate(change)


def test_a_reservation_has_an_event_and_days_in_order():
    base = {"event": "Fall Camp", "starts": "2026-10-02", "ends": "2026-10-04"}
    validate(created("reservation", base))
    validate(created("reservation", {**base, "items": ["tent-1"], "generics": [{"item_id": "t", "quantity": 2}]}))
    with pytest.raises(Rejected, match="ends before it starts"):
        validate(created("reservation", {**base, "ends": "2026-10-01"}))
    with pytest.raises(Rejected, match="starts: String should match pattern"):
        validate(created("reservation", {**base, "starts": "Oct 2"}))
    with pytest.raises(Rejected, match="generics.0.quantity"):
        validate(created("reservation", {**base, "generics": [{"item_id": "t", "quantity": 0}]}))


def test_a_reservations_gear_list_is_edited_one_line_at_a_time():
    """A whole-list write would drop the extra the other phone added (FR-RES-07)."""
    line = incoming(entity_type="reservation", entity_id="res-1", type="item_added", payload={"item_id": "tent-1"})
    validate(line)
    validate({**line, "type": "item_removed"})
    validate({**line, "type": "quantity_changed", "payload": {"item_id": "tarp", "quantity": 0}})

    with pytest.raises(Rejected, match="the gear list is edited one line at a time"):
        validate(
            incoming(
                entity_type="reservation", entity_id="res-1", payload={"field": "items", "value": [], "old": ["t"]}
            )
        )
    with pytest.raises(Rejected, match="the gear list is edited one line at a time"):
        validate(
            incoming(
                entity_type="reservation", entity_id="res-1", payload={"field": "generics", "value": [], "old": []}
            )
        )
    with pytest.raises(Rejected, match="item_added applies only to reservations"):
        validate({**line, "entity_type": "item"})
    with pytest.raises(Rejected, match="quantity: Input should be greater than or equal to 0"):
        validate({**line, "type": "quantity_changed", "payload": {"item_id": "tarp", "quantity": -1}})


def test_a_movements_event_is_corrected_by_naming_it():
    """The same shape as a note correction (FR-RES-17, FR-OUT-16)."""
    fix = incoming(type="event_corrected", payload={"movement_id": new_ulid(), "event": "Fall Camp"})
    validate(fix)
    validate({**fix, "payload": {**fix["payload"], "event": None}})
    with pytest.raises(Rejected, match="movement_id: not a ULID"):
        validate({**fix, "payload": {"movement_id": "nope", "event": "Fall Camp"}})
    with pytest.raises(Rejected, match="event: Field required"):
        validate({**fix, "payload": {"movement_id": new_ulid()}})
    with pytest.raises(Rejected, match="event_corrected applies only to items"):
        validate({**fix, "entity_type": "reservation", "entity_id": "res-1"})


def test_a_found_report_can_only_be_resolved():
    validate(created("found_report", {"code": "AAAAAAAAAA", "item_id": None, "note": "by the gate"}))
    ok = incoming(
        entity_type="found_report", entity_id="f-1", payload={"field": "resolved", "value": True, "old": None}
    )
    validate(ok)
    for payload in (
        {"field": "note", "value": "edited", "old": "by the gate"},
        {"field": "resolved", "value": "yes", "old": None},
    ):
        with pytest.raises(Rejected, match="can only be resolved"):
            validate(incoming(entity_type="found_report", entity_id="f-1", payload=payload))


def test_a_photo_goes_on_an_item_or_a_ticket_and_nothing_else():
    photo = {"photo_id": "01000000000000000000000AAA", "content_type": "image/jpeg", "size": 10}
    validate(incoming(type="photo_added", payload=photo))
    validate(incoming(entity_type="repair", entity_id="rep-1", type="photo_added", payload=photo))
    validate(incoming(type="photo_removed", payload={"photo_id": "01000000000000000000000AAA"}))
    with pytest.raises(Rejected, match="applies only to items and repair tickets"):
        validate(incoming(entity_type="location", entity_id="loc-1", type="photo_added", payload=photo))
    with pytest.raises(Rejected, match="content_type"):
        validate(incoming(type="photo_added", payload={**photo, "content_type": "image/gif"}))
    with pytest.raises(Rejected, match="photo_id: not a ULID"):
        validate(incoming(type="photo_removed", payload={"photo_id": "nope"}))
