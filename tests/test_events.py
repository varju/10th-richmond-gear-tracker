"""The log, against the real database."""

from __future__ import annotations

import sqlite3

import pytest

from gear_tracker.db import connect
from gear_tracker.events import ENTITY_TYPES, Rejected, append, get, in_replay_order, since
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
    for n, entity_type in enumerate(sorted(ENTITY_TYPES), start=1):
        append(db, incoming(entity_type=entity_type, entity_id=f"{entity_type}-1", device_seq=n), received_at=T0)
    types = {r["entity_type"] for r in db.execute("SELECT entity_type FROM events")}
    assert types == ENTITY_TYPES


def test_stored_row_round_trips(db):
    e = incoming(payload={"field": "name", "value": "Tent, 4 person", "note": None})
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
