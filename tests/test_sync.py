"""push, pull and bootstrap against the real database. HTTP is tested separately in test_app."""

from __future__ import annotations

import pytest

from gear_tracker import events
from gear_tracker.derived import snapshot
from gear_tracker.flags import list_flags
from gear_tracker.sync import (
    DRIFT_THRESHOLD_MS,
    RETENTION_MS,
    BadRequest,
    Deactivated,
    Forbidden,
    Principal,
    Rebootstrap,
    bootstrap,
    pull,
    push,
)
from gear_tracker.ulid import new_ulid
from tests.factories import T0, incoming

HOUR = 3_600_000
DAY = 24 * HOUR

ALICE = Principal(user_id="alice", device_id="phone-a")
BOB = Principal(user_id="bob", device_id="phone-b")


def batch(principal: Principal, *events: dict, client_time: int = T0) -> dict:
    return {"device_id": principal.device_id, "client_time": client_time, "events": list(events)}


def own(principal: Principal, **overrides) -> dict:
    return incoming(**{"actor_id": principal.user_id, "device_id": principal.device_id, **overrides})


# --- push ---------------------------------------------------------------------


def test_push_accepts_and_rejects_per_event(db):
    good = own(ALICE, device_seq=1)
    bad = own(ALICE, device_seq=2, entity_type="spaceship")

    result = push(db, ALICE, batch(ALICE, good, bad), now=T0)

    assert result["accepted"] == [good["id"]]
    [rejection] = result["rejected"]
    assert rejection["id"] == bad["id"]
    assert rejection["reason"].startswith("entity_type: Input should be 'item', 'item_type', 'user'")
    assert result["server_time"] == T0


def test_a_rejection_does_not_block_the_events_behind_it(db):
    bad = own(ALICE, device_seq=1, type="teleported")
    good = own(ALICE, device_seq=2)

    result = push(db, ALICE, batch(ALICE, bad, good), now=T0)
    assert result["accepted"] == [good["id"]]


def test_the_same_push_replayed_twice_changes_nothing(db):
    body = batch(ALICE, own(ALICE, device_seq=1, type="created", payload={"name": "Tent"}), own(ALICE, device_seq=2))

    first = push(db, ALICE, body, now=T0)
    count = db.execute("SELECT count(*) FROM events").fetchone()[0]
    state = snapshot(db)

    second = push(db, ALICE, body, now=T0 + 1000)
    assert second["accepted"] == first["accepted"]
    assert second["rejected"] == []
    assert db.execute("SELECT count(*) FROM events").fetchone()[0] == count
    assert snapshot(db) == state
    assert list_flags(db) == []


def test_events_are_attributed_to_the_credential_not_the_payload(db):
    forged_actor = own(ALICE, device_seq=1, actor_id="bob")
    forged_device = own(ALICE, device_seq=2, device_id="phone-b")

    result = push(db, ALICE, batch(ALICE, forged_actor, forged_device), now=T0)

    assert result["accepted"] == []
    assert [r["reason"] for r in result["rejected"]] == [
        "actor_id must be the signed-in user",
        "device_id must be this device",
    ]


def test_push_from_the_wrong_device_is_refused_whole(db):
    with pytest.raises(Forbidden, match="device_id"):
        push(db, ALICE, batch(BOB, own(ALICE)), now=T0)


@pytest.mark.parametrize(
    "body",
    [
        None,
        [],
        {"device_id": "phone-a", "events": []},
        {"device_id": "phone-a", "client_time": "now", "events": []},
        {"device_id": "phone-a", "client_time": T0, "events": {}},
    ],
)
def test_push_rejects_a_malformed_body(db, body):
    with pytest.raises((BadRequest, Forbidden)):
        push(db, ALICE, body, now=T0)


def test_a_non_object_event_is_rejected_not_fatal(db):
    result = push(db, ALICE, batch(ALICE, "not an event", own(ALICE)), now=T0)
    assert len(result["accepted"]) == 1
    assert result["rejected"] == [{"id": None, "reason": "event must be a JSON object"}]


def test_two_devices_offline_on_one_item_lose_nothing(db):
    """FR-OFF-05. Both phones append; both land; replay orders them."""
    push(db, ALICE, batch(ALICE, own(ALICE, device_seq=1, type="created", payload={"name": "Tent"})), now=T0)

    a_out = own(ALICE, device_seq=2, type="checked_out", payload={"holder_id": "alice"}, occurred_at=T0 + HOUR)
    b_in = own(BOB, device_seq=1, type="checked_in", payload={}, occurred_at=T0 + 2 * HOUR)
    b_note = own(BOB, device_seq=2, type="note_added", payload={"text": "muddy"}, occurred_at=T0 + 2 * HOUR)

    # Bob syncs first even though his events happened later.
    push(db, BOB, batch(BOB, b_in, b_note), now=T0 + 3 * HOUR)
    push(db, ALICE, batch(ALICE, a_out), now=T0 + 4 * HOUR)

    assert db.execute("SELECT count(*) FROM events").fetchone()[0] == 4
    tent = snapshot(db)["item"]["tent-1"]
    assert tent["status"] == "in"
    assert [n["text"] for n in tent["notes"]] == ["muddy"]


def test_two_check_outs_from_different_devices_are_queued_not_guessed(db):
    """FR-OFF-10."""
    a = own(ALICE, device_seq=1, type="checked_out", payload={"holder_id": "alice"}, occurred_at=T0)
    b = own(BOB, device_seq=1, type="checked_out", payload={"holder_id": "bob"}, occurred_at=T0 + 1)
    push(db, ALICE, batch(ALICE, a), now=T0 + HOUR)
    push(db, BOB, batch(BOB, b), now=T0 + HOUR)

    tent = snapshot(db)["item"]["tent-1"]
    assert tent["holder_id"] == "bob"
    assert [c["kind"] for c in tent["conflicts"]] == ["double_checkout"]
    assert [e["id"] for e in tent["conflicts"][0]["events"]] == [a["id"], b["id"]]


# --- clocks -------------------------------------------------------------------


def test_a_device_three_hours_fast_syncing_two_days_later_records_the_right_time(db):
    """NFR-DATA-13. The offset was measured at sign-in and stamped on the event; the clamp alone could not fix this."""
    friday = T0
    fast = 3 * HOUR
    sunday = friday + 2 * DAY

    # The phone reads friday + 3h and knows it is 3h fast.
    event = own(ALICE, occurred_at=friday + fast, clock_offset=-fast)
    result = push(db, ALICE, batch(ALICE, event, client_time=sunday + fast), now=sunday)

    assert result["accepted"] == [event["id"]]
    stored = db.execute("SELECT occurred_at, effective_at FROM events").fetchone()
    assert stored["effective_at"] == friday
    assert stored["occurred_at"] == friday + fast, "the raw reading is kept"
    assert list_flags(db) == [], "the clock did not move, so nothing is suspect"


def test_a_clock_that_moved_since_recording_flags_the_events(db):
    # Recorded believing the clock was right; by sync time it is two hours off.
    event = own(ALICE, occurred_at=T0, clock_offset=0)
    push(db, ALICE, batch(ALICE, event, client_time=T0 + DAY + 2 * HOUR), now=T0 + DAY)

    [flag] = list_flags(db, "clock_drift")
    assert flag["event_id"] == event["id"]
    assert flag["detail"] == {"recorded_offset": 0, "measured_offset": -2 * HOUR, "drift": -2 * HOUR}


def test_drift_within_the_threshold_is_not_flagged(db):
    event = own(ALICE, occurred_at=T0, clock_offset=0)
    push(db, ALICE, batch(ALICE, event, client_time=T0 + DRIFT_THRESHOLD_MS), now=T0)
    assert list_flags(db) == []


def test_a_replayed_push_does_not_flag_twice(db):
    event = own(ALICE, occurred_at=T0, clock_offset=0)
    body = batch(ALICE, event, client_time=T0 + 2 * HOUR)
    push(db, ALICE, body, now=T0)
    push(db, ALICE, body, now=T0)
    assert len(list_flags(db)) == 1


# --- pull -----------------------------------------------------------------------


def test_pull_is_an_exclusive_cursor_over_seq(db):
    push(db, ALICE, batch(ALICE, *[own(ALICE, device_seq=n) for n in range(1, 6)]), now=T0)

    page = pull(db, ALICE, cursor=2, now=T0)
    assert [e["seq"] for e in page["events"]] == [3, 4, 5]
    assert page["cursor"] == 5
    assert page["server_time"] == T0

    empty = pull(db, ALICE, cursor=5, now=T0)
    assert empty["events"] == []
    assert empty["cursor"] == 5


def test_pull_returns_whole_events(db):
    [event] = push(db, ALICE, batch(ALICE, own(ALICE)), now=T0 + 7)["accepted"]

    [pulled] = pull(db, ALICE, cursor=0, now=T0 + 7)["events"]
    assert pulled["id"] == event
    assert pulled["received_at"] == T0 + 7
    assert pulled["payload"] == {"field": "name", "value": "Tent", "old": None}


def test_an_event_committing_out_of_time_order_is_still_delivered(db):
    push(db, ALICE, batch(ALICE, own(ALICE, occurred_at=T0 + HOUR)), now=T0 + HOUR)
    cursor = pull(db, BOB, cursor=0, now=T0 + HOUR)["cursor"]

    # Bob's event happened earlier but arrives later. A time cursor would skip it.
    late = own(BOB, occurred_at=T0)
    push(db, BOB, batch(BOB, late), now=T0 + 2 * HOUR)

    page = pull(db, ALICE, cursor=cursor, now=T0 + 2 * HOUR)
    assert [e["id"] for e in page["events"]] == [late["id"]]


def test_a_cursor_ahead_of_the_log_means_re_bootstrap(db):
    """The database was restored from backup and the device knows more than the server."""
    push(db, ALICE, batch(ALICE, own(ALICE)), now=T0)
    with pytest.raises(Rebootstrap, match="restored"):
        pull(db, ALICE, cursor=99, now=T0)


def test_a_cursor_older_than_retention_means_re_bootstrap(db):
    push(db, ALICE, batch(ALICE, own(ALICE, device_seq=1)), now=T0)
    push(db, ALICE, batch(ALICE, own(ALICE, device_seq=2)), now=T0 + RETENTION_MS)

    with pytest.raises(Rebootstrap, match="retention"):
        pull(db, ALICE, cursor=1, now=T0 + RETENTION_MS + 1)
    with pytest.raises(Rebootstrap, match="retention"):
        pull(db, ALICE, cursor=0, now=T0 + RETENTION_MS + 1)
    # The recent one is fine.
    assert pull(db, ALICE, cursor=2, now=T0 + RETENTION_MS + 1)["events"] == []


def test_an_empty_log_honours_any_zero_cursor(db):
    assert pull(db, ALICE, cursor=0, now=T0)["events"] == []


def test_pull_rejects_a_bad_cursor(db):
    with pytest.raises(BadRequest):
        pull(db, ALICE, cursor=-1, now=T0)


# --- bootstrap -----------------------------------------------------------------


def test_bootstrap_is_the_snapshot_and_the_cursor_it_was_true_at(db):
    push(db, ALICE, batch(ALICE, own(ALICE, type="created", payload={"name": "Tent"})), now=T0)

    result = bootstrap(db, ALICE, now=T0)
    assert result["snapshot"] == snapshot(db)
    assert result["cursor"] == 1
    assert result["server_time"] == T0


def test_bootstrap_includes_an_item_last_touched_two_years_ago(db):
    """FR-OFF-14: replaying 90 days could never produce this; the snapshot does."""
    two_years = 730 * DAY
    push(db, ALICE, batch(ALICE, own(ALICE, entity_id="old-tent", type="created", payload={"name": "Old"})), now=T0)
    push(
        db,
        ALICE,
        batch(ALICE, own(ALICE, device_seq=2, entity_id="new-tent", type="created", payload={"name": "New"})),
        now=T0 + two_years,
    )

    result = bootstrap(db, ALICE, now=T0 + two_years)
    assert set(result["snapshot"]["item"]) == {"old-tent", "new-tent"}
    assert result["cursor"] == 2


# --- deactivated accounts ------------------------------------------------------


def test_a_deactivated_account_can_still_push_and_is_attributed(db):
    """FR-OFF-06."""
    gone = Principal(user_id="alice", device_id="phone-a", active=False)
    event = own(gone)

    result = push(db, gone, batch(gone, event), now=T0)

    assert result["accepted"] == [event["id"]]
    assert db.execute("SELECT actor_id FROM events").fetchone()[0] == "alice"


def test_a_deactivated_account_can_do_nothing_else(db):
    gone = Principal(user_id="alice", device_id="phone-a", active=False)
    with pytest.raises(Deactivated):
        pull(db, gone, cursor=0, now=T0)
    with pytest.raises(Deactivated):
        bootstrap(db, gone, now=T0)


# --- what a device may not do -----------------------------------------------------------

USER = Principal("alice", "phone-a")
ADMIN = Principal("alice", "phone-a", role="admin")


def reasons(db, principal, *events_):
    result = push(db, principal, {"device_id": "phone-a", "client_time": T0, "events": list(events_)}, now=T0)
    return [r["reason"] for r in result["rejected"]]


def test_settings_take_an_admin(db):
    change = own(USER, entity_type="setting", entity_id="group", type="created", payload={"name": "10th Richmond"})
    assert reasons(db, USER, change) == ["settings are changed by an Admin"]
    assert reasons(db, ADMIN, {**change, "id": new_ulid()}) == []


def test_devices_bind_codes_but_do_not_make_them(db):
    made = own(ADMIN, entity_type="code", entity_id="ABCDEFGH23", type="created", payload={})
    assert reasons(db, ADMIN, made) == ["codes come from printed sheets"]

    bind = own(ADMIN, entity_type="code", entity_id="ABCDEFGH23", type="code_bound", payload={"item_id": "tent-1"})
    assert reasons(db, ADMIN, bind) == ["not one of our codes"]

    events.append_server(db, "alice", "code", "ABCDEFGH23", "created", {}, now=T0)
    assert reasons(db, ADMIN, {**bind, "id": new_ulid(), "device_seq": 2}) == []
    again = own(ADMIN, entity_type="code", entity_id="ABCDEFGH23", type="code_bound", payload={"item_id": "tent-2"})
    assert reasons(db, ADMIN, {**again, "device_seq": 3}) == ["this code is already on an item"]


def test_created_may_not_set_system_fields(db):
    made = own(USER, type="created", payload={"name": "Tent", "added_at": 1})
    assert reasons(db, USER, made) == ["payload: added_at is set by the system, not by created"]


def test_retired_items_cannot_be_checked_out(db):
    push(
        db,
        USER,
        {
            "device_id": "phone-a",
            "client_time": T0,
            "events": [
                own(USER, type="created", payload={"name": "Tent"}, device_seq=1),
                own(USER, payload={"field": "retired", "value": True, "old": None}, device_seq=2),
            ],
        },
        now=T0,
    )
    out = own(USER, type="checked_out", payload={"holder_id": "alice"}, device_seq=3)
    assert reasons(db, USER, out) == ["retired items cannot be checked out (FR-INV-04)"]
