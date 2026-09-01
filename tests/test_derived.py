"""The cache must never disagree with a fresh replay of the log."""

from __future__ import annotations

import json

import pytest

from gear_tracker.derived import cursor, rebuild, snapshot
from gear_tracker.events import Rejected, append, in_replay_order
from gear_tracker.replay import replay
from tests.factories import T0, incoming

DAY = 86_400_000


def busy_weekend(db):
    """Two phones, one item, events landing out of time order."""
    append(db, incoming(device_id="a", device_seq=1, type="created", payload={"name": "Tent"}), received_at=T0)
    append(db, incoming(device_id="a", device_seq=2, type="checked_out", payload={"holder_id": "bob"}), received_at=T0)
    # Phone b checked it back in on Saturday but only syncs on Sunday.
    append(
        db,
        incoming(device_id="b", device_seq=1, type="checked_in", payload={}, occurred_at=T0 + DAY),
        received_at=T0 + 2 * DAY,
    )
    # Meanwhile phone a saw it go out again on Saturday evening, and synced first.
    append(
        db,
        incoming(
            device_id="a", device_seq=3, type="checked_out", payload={"holder_id": "carol"}, occurred_at=T0 + DAY + 1
        ),
        received_at=T0 + DAY + 2,
    )
    append(
        db,
        incoming(device_id="b", device_seq=2, entity_id="stove-1", type="created", payload={"name": "Stove"}),
        received_at=T0 + 2 * DAY,
    )


def test_cache_matches_a_fresh_replay(db):
    busy_weekend(db)
    assert snapshot(db) == replay(in_replay_order(db))


def test_cache_reflects_replay_order_not_arrival_order(db):
    busy_weekend(db)
    tent = snapshot(db)["item"]["tent-1"]
    assert tent["status"] == "out"
    assert tent["holder_id"] == "carol"


def test_cursor_is_the_last_seq(db):
    busy_weekend(db)
    assert cursor(db) == db.execute("SELECT max(seq) FROM events").fetchone()[0]


def test_rebuild_restores_a_damaged_cache(db):
    busy_weekend(db)
    before = snapshot(db)

    db.execute("UPDATE entities SET state = ? WHERE entity_id = 'tent-1'", (json.dumps({"name": "wrong"}),))
    db.execute("DELETE FROM entities WHERE entity_id = 'stove-1'")
    db.execute("UPDATE meta SET value = '0' WHERE key = 'derived_seq'")
    assert snapshot(db) != before

    assert rebuild(db) == 2
    assert snapshot(db) == before
    assert cursor(db) == db.execute("SELECT max(seq) FROM events").fetchone()[0]


def test_rebuild_of_an_empty_log(db):
    assert rebuild(db) == 0
    assert snapshot(db) == {}
    assert cursor(db) == 0


def test_a_rejected_event_leaves_the_cache_alone(db):
    busy_weekend(db)
    before = snapshot(db)
    with pytest.raises(Rejected):
        append(db, incoming(device_id="a", device_seq=1, type="checked_in", payload={}), received_at=T0)
    assert snapshot(db) == before


def test_derived_fields_cannot_be_set_directly(db):
    with pytest.raises(Rejected, match="derived"):
        append(db, incoming(payload={"field": "status", "value": "in", "old": "out"}), received_at=T0)


@pytest.mark.parametrize(
    ("event_type", "payload", "reason"),
    [
        ("field_changed", {"value": 1, "old": 0}, "payload.field: Field required"),
        ("field_changed", {"field": "name", "old": 0}, "payload.value: Field required"),
        ("field_changed", {"field": "name", "value": 1}, "payload.old: Field required"),
        ("field_changed", {"field": "name", "value": 1, "old": None, "extra": 2}, None),
        ("note_added", {}, "payload.text: Field required"),
        ("note_added", {"text": 7}, "payload.text: Input should be a valid string"),
        ("note_corrected", {"text": "x"}, "payload.note_id: Field required"),
        ("note_corrected", {"note_id": "nope", "text": "x"}, "payload.note_id: not a ULID"),
        ("note_corrected", {"note_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV"}, "payload.text: Field required"),
        ("checked_out", {}, "payload.holder_id: Field required"),
        ("checked_out", {"holder_id": ""}, "payload.holder_id: String should have at least 1 character"),
    ],
)
def test_payload_shape_is_checked_at_the_door(db, event_type, payload, reason):
    if reason is None:
        stored = append(db, incoming(type=event_type, payload=payload), received_at=T0)
        assert stored.payload == payload, "unknown keys are kept, not dropped"
        return
    with pytest.raises(Rejected) as exc:
        append(db, incoming(type=event_type, payload=payload), received_at=T0)
    assert exc.value.reason == reason
