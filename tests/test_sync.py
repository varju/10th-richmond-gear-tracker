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
    log_id,
    pull,
    push,
)
from gear_tracker.ulid import new_ulid
from tests.factories import T0, incoming

HOUR = 3_600_000
DAY = 24 * HOUR

ALICE = Principal(user_id="alice", device_id="phone-a")
BOB = Principal(user_id="bob", device_id="phone-b")


def batch(principal: Principal, *events: dict, client_time: int = T0, round_trip_ms: int | None = None) -> dict:
    body = {"device_id": principal.device_id, "client_time": client_time, "events": list(events)}
    if round_trip_ms is not None:
        body["round_trip_ms"] = round_trip_ms
    return body


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
    assert rejection["reason"].startswith("entity_type: Input should be 'item', 'user'")
    assert result["server_time"] == T0


def test_a_rejection_is_logged_at_warning_level(db, caplog):
    bad = own(ALICE, device_seq=1, entity_type="spaceship")

    with caplog.at_level("WARNING"):
        push(db, ALICE, batch(ALICE, bad), now=T0)

    [record] = caplog.records
    assert record.levelname == "WARNING"
    message = record.getMessage()
    assert bad["id"] in message
    assert "spaceship" in message
    assert "tent-1" in message
    assert ALICE.device_id in message
    assert "entity_type: Input should be 'item', 'user'" in message


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
    result = push(db, ALICE, batch(ALICE, "not an event", own(ALICE)), now=T0)  # type: ignore
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


def test_a_slow_push_does_not_flag_when_the_round_trip_is_reported(db):
    """The client's own offset already allows for half a round trip; the server's should too."""
    event = own(ALICE, occurred_at=T0, clock_offset=0)
    body = batch(ALICE, event, client_time=T0 - 90_000, round_trip_ms=180_000)
    push(db, ALICE, body, now=T0)
    assert list_flags(db) == []


def test_the_same_lag_with_no_round_trip_reported_flags_it(db):
    event = own(ALICE, occurred_at=T0, clock_offset=0)
    body = batch(ALICE, event, client_time=T0 - 90_000)
    push(db, ALICE, body, now=T0)
    [flag] = list_flags(db, "clock_drift")
    assert flag["detail"]["measured_offset"] == 90_000


def test_a_negative_round_trip_is_a_bad_request(db):
    event = own(ALICE, occurred_at=T0, clock_offset=0)
    body = batch(ALICE, event, client_time=T0, round_trip_ms=-1)
    with pytest.raises(BadRequest):
        push(db, ALICE, body, now=T0)


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


def test_a_cursor_equal_to_the_last_event_never_needs_retention(db):
    """A device that has missed nothing should not be told to re-bootstrap just because it has been quiet."""
    push(db, ALICE, batch(ALICE, own(ALICE)), now=T0)

    page = pull(db, ALICE, cursor=1, now=T0 + RETENTION_MS + 1)
    assert page["events"] == []
    assert page["cursor"] == 1


def test_a_cursor_from_a_different_log_means_re_bootstrap(db):
    """The server database was replaced, and its new log has grown past the device's cursor."""
    push(db, ALICE, batch(ALICE, own(ALICE)), now=T0)

    with pytest.raises(Rebootstrap, match="different database"):
        pull(db, ALICE, cursor=0, now=T0, log="not-this-log")


def test_a_cursor_from_this_log_is_honoured(db):
    push(db, ALICE, batch(ALICE, own(ALICE)), now=T0)
    mine = log_id(db)

    assert len(pull(db, ALICE, cursor=0, now=T0, log=mine)["events"]) == 1
    # A device that has not learned the log id yet is still served.
    assert len(pull(db, ALICE, cursor=0, now=T0)["events"]) == 1


def test_every_sync_result_carries_the_log_id(db):
    mine = log_id(db)

    assert bootstrap(db, ALICE, now=T0)["log_id"] == mine
    assert push(db, ALICE, batch(ALICE, own(ALICE)), now=T0)["log_id"] == mine
    assert pull(db, ALICE, cursor=0, now=T0)["log_id"] == mine


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


def test_locations_take_an_admin(db):
    made = own(USER, entity_type="location", entity_id="loc-1", type="created", payload={"name": "Shed"})
    assert reasons(db, USER, made) == ["locations are an Admin's job (FR-SET-05)"]
    assert reasons(db, ADMIN, {**made, "id": new_ulid()}) == []


def test_anyone_may_create_a_category_but_only_an_admin_changes_one(db):
    made = own(USER, entity_type="category", entity_id="cat-1", type="created", payload={"name": "Tents"})
    assert reasons(db, USER, made) == []

    renamed = own(
        USER,
        entity_type="category",
        entity_id="cat-1",
        payload={"field": "name", "value": "Tarps", "old": "Tents"},
        device_seq=2,
    )
    assert reasons(db, USER, renamed) == ["categories are renamed and deleted by an Admin (FR-SET-05)"]
    assert reasons(db, ADMIN, {**renamed, "id": new_ulid()}) == []


def test_items_are_merged_by_an_admin(db):
    push(
        db,
        USER,
        batch(
            USER,
            own(USER, type="created", payload={"name": "Tent"}, device_seq=1),
            own(USER, entity_id="tent-2", type="created", payload={"name": "Tent"}, device_seq=2),
        ),
        now=T0,
    )
    merge = own(USER, payload={"field": "merged_into", "value": "tent-2", "old": None}, device_seq=3)
    assert reasons(db, USER, merge) == ["items are merged by an Admin (FR-INV-13)"]
    assert reasons(db, ADMIN, {**merge, "id": new_ulid()}) == []


def test_anyone_folds_one_thing_into_a_new_shape(db):
    """A fold changes an item's kind (FR-INV-33, FR-INV-34, FR-INV-39, FR-INV-40); a merge says two
    records are one (FR-INV-13). Both write `merged_into`, and only the merge takes an Admin."""
    push(
        db,
        USER,
        batch(
            USER,
            own(USER, type="created", payload={"name": "Bowl"}, device_seq=1),
            own(
                USER,
                entity_id="bowls",
                type="created",
                payload={"name": "Bowls", "generic": True, "pool": True, "quantity": 12},
                device_seq=2,
            ),
            own(USER, entity_id="tents", type="created", payload={"name": "Tent", "generic": True}, device_seq=3),
            own(USER, entity_id="tent-2", type="created", payload={"name": "Tent"}, device_seq=4),
            own(USER, entity_id="tarps", type="created", payload={"name": "Tarp", "generic": True}, device_seq=5),
            own(
                USER,
                entity_id="tarp-1",
                type="created",
                payload={"name": "Tarp", "parent_id": "tarps", "number": "1"},
                device_seq=6,
            ),
        ),
        now=T0,
    )

    def fold(source: str, target: str, seq: int) -> dict:
        return own(
            USER, entity_id=source, payload={"field": "merged_into", "value": target, "old": None}, device_seq=seq
        )

    # A single item becomes a counted pool (FR-INV-34).
    assert reasons(db, USER, fold("tent-1", "bowls", 7)) == []
    # A generic with nothing under it becomes a single item (FR-INV-39).
    assert reasons(db, USER, fold("tents", "tent-2", 8)) == []
    # A generic that still has a unit is not folded: that would be two records of one thing.
    assert reasons(db, USER, fold("tarps", "tent-2", 9)) == ["items are merged by an Admin (FR-INV-13)"]
    # Nor is one single item into another.
    assert reasons(db, USER, fold("tent-2", "tarp-1", 10)) == ["items are merged by an Admin (FR-INV-13)"]


def test_devices_bind_codes_but_do_not_make_them(db):
    made = own(ADMIN, entity_type="code", entity_id="ABCDEFGH23", type="created", payload={})
    assert reasons(db, ADMIN, made) == ["codes come from printed sheets"]

    bind = own(ADMIN, entity_type="code", entity_id="ABCDEFGH23", type="code_bound", payload={"item_id": "tent-1"})
    assert reasons(db, ADMIN, bind) == ["not one of our codes"]

    events.append_server(db, "alice", "code", "ABCDEFGH23", "created", {}, now=T0)
    assert reasons(db, ADMIN, {**bind, "id": new_ulid(), "device_seq": 2}) == []
    again = own(ADMIN, entity_type="code", entity_id="ABCDEFGH23", type="code_bound", payload={"item_id": "tent-2"})
    assert reasons(db, ADMIN, {**again, "device_seq": 3}) == ["this code is already on an item"]


def test_any_signed_in_user_may_release_a_bound_code(db):
    unmade = own(USER, entity_type="code", entity_id="ZZZZZZZZZZ", type="code_released", payload={})
    assert reasons(db, USER, unmade) == ["not one of our codes"]

    events.append_server(db, "alice", "code", "ABCDEFGH23", "created", {}, now=T0)
    release = own(USER, entity_type="code", entity_id="ABCDEFGH23", type="code_released", payload={}, device_seq=2)
    assert reasons(db, USER, release) == ["this code is not on anything"]

    events.append_server(db, "alice", "code", "ABCDEFGH23", "code_bound", {"item_id": "tent-1"}, now=T0)
    assert reasons(db, USER, {**release, "device_seq": 3}) == []


def test_created_may_not_set_system_fields(db):
    made = own(USER, type="created", payload={"name": "Tent", "added_at": 1})
    assert reasons(db, USER, made) == ["payload: added_at is set by the system, not by created"]


def test_an_item_created_may_not_carry_item_id(db):
    """item_id is plain data on a ticket or a found report, but an item has no such field of its own."""
    made = own(USER, type="created", payload={"name": "Tent", "item_id": "tent-1"})
    assert reasons(db, USER, made) == ["payload: item_id is set by the system, not by created"]


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


def test_items_are_deleted_by_an_admin_and_then_cannot_move(db):
    """A record made in error goes for good; only an Admin writes the field (FR-INV-32)."""
    made = own(USER, type="created", payload={"name": "Tent"}, device_seq=1)
    assert reasons(db, USER, made) == []

    gone = own(USER, payload={"field": "deleted", "value": True, "old": None}, device_seq=2)
    assert reasons(db, USER, gone) == ["items are deleted by an Admin"]
    assert reasons(db, ADMIN, {**gone, "id": new_ulid()}) == []

    out = own(ADMIN, type="checked_out", payload={"holder_id": "alice"}, device_seq=3)
    assert reasons(db, ADMIN, out) == ["this item was deleted"]
    back = own(ADMIN, type="checked_in", payload={}, device_seq=4)
    assert reasons(db, ADMIN, back) == ["this item was deleted"]


def test_a_device_cannot_file_a_found_report(db):
    forged = own(
        ALICE,
        device_seq=1,
        entity_type="found_report",
        entity_id="f-1",
        type="created",
        payload={"code": "AAAAAAAAAA", "item_id": None, "note": "by the gate"},
    )
    result = push(db, ALICE, batch(ALICE, forged), now=T0)
    assert result["rejected"][0]["reason"] == "found reports come from the public page"


def test_a_device_cannot_say_a_photo_was_stored(db):
    """The server writes photo_added itself, after it has the file. A device only removes."""
    forged = own(
        ALICE,
        device_seq=1,
        type="photo_added",
        payload={"photo_id": "01000000000000000000000AAA", "content_type": "image/jpeg", "size": 10},
    )
    removed = own(ALICE, device_seq=2, type="photo_removed", payload={"photo_id": "01000000000000000000000AAA"})
    result = push(db, ALICE, batch(ALICE, forged, removed), now=T0)
    assert result["rejected"][0]["reason"] == "photos are uploaded, not pushed"
    assert result["accepted"] == [removed["id"]]


def test_merged_items_cannot_be_checked_out(db):
    push(
        db,
        ADMIN,
        {
            "device_id": "phone-a",
            "client_time": T0,
            "events": [
                own(ADMIN, type="created", payload={"name": "Tent"}, device_seq=1),
                own(ADMIN, payload={"field": "merged_into", "value": "tent-2", "old": None}, device_seq=2),
            ],
        },
        now=T0,
    )
    out = own(USER, type="checked_out", payload={"holder_id": "alice"}, device_seq=3)
    assert reasons(db, USER, out) == ["this item was merged into another (FR-INV-13)"]


def test_a_generic_item_does_not_move(db):
    """One entity kind, two guards: a generic takes no movement and no code (FR-INV-21)."""
    push(
        db,
        USER,
        batch(USER, own(USER, type="created", payload={"name": "4-person tent", "generic": True}, device_seq=1)),
        now=T0,
    )
    out = own(USER, type="checked_out", payload={"holder_id": "alice"}, device_seq=2)
    back = own(USER, type="checked_in", payload={}, device_seq=3)
    assert reasons(db, USER, out) == ["a generic item does not move; its units do (FR-INV-21)"]
    assert reasons(db, USER, back) == ["a generic item does not move; its units do (FR-INV-21)"]


def test_a_generic_item_takes_no_code(db):
    push(
        db,
        USER,
        batch(USER, own(USER, type="created", payload={"name": "4-person tent", "generic": True}, device_seq=1)),
        now=T0,
    )
    events.append_server(db, "alice", "code", "ABCDEFGH23", "created", {}, now=T0)
    bind = own(USER, entity_type="code", entity_id="ABCDEFGH23", type="code_bound", payload={"item_id": "tent-1"})
    refused = ["a generic item takes no code; put it on a unit (FR-INV-21)"]
    assert reasons(db, USER, {**bind, "device_seq": 2}) == refused

    # Its unit does take one.
    unit = own(USER, entity_id="tent-1-1", type="created", payload={"parent_id": "tent-1", "number": "1"}, device_seq=3)
    assert reasons(db, USER, unit) == []
    on_unit = own(
        USER,
        entity_type="code",
        entity_id="ABCDEFGH23",
        type="code_bound",
        payload={"item_id": "tent-1-1"},
        device_seq=4,
    )
    assert reasons(db, USER, on_unit) == []


def test_a_unit_may_take_the_number_another_phone_used(db):
    """Numbers are picked on the device. The offline collision is accepted; both units land (FR-INV-23)."""
    push(
        db,
        USER,
        batch(USER, own(USER, type="created", payload={"name": "3x3 tarp", "generic": True}, device_seq=1)),
        now=T0,
    )
    mine = own(USER, entity_id="tarp-a", type="created", payload={"parent_id": "tent-1", "number": "2"}, device_seq=2)
    theirs = own(BOB, entity_id="tarp-b", type="created", payload={"parent_id": "tent-1", "number": "2"}, device_seq=1)
    assert reasons(db, USER, mine) == []
    result = push(db, BOB, {"device_id": "phone-b", "client_time": T0, "events": [theirs]}, now=T0)
    assert result["accepted"] == [theirs["id"]]
    assert snapshot(db)["item"]["tarp-a"]["number"] == "2"
    assert snapshot(db)["item"]["tarp-b"]["number"] == "2"


# --- pools (FR-INV-34) -----------------------------------------------------------------------


def test_a_pool_must_be_generic(db):
    ok = own(USER, type="created", payload={"name": "Bowls", "generic": True, "pool": True, "quantity": 20})
    assert reasons(db, USER, ok) == []
    bad = own(USER, entity_id="tent-2", type="created", payload={"name": "Cups", "pool": True, "quantity": 20})
    assert reasons(db, USER, bad) == ["a pool must be generic (FR-INV-34)"]


def test_pool_and_quantity_are_set_only_at_creation(db):
    """Flipping either afterwards would drop outstanding stock or turn a checked-out item into a pool."""
    push(db, USER, batch(USER, own(USER, type="created", payload={"name": "Tent"})), now=T0)
    for field, value in (("pool", True), ("quantity", 5)):
        change = own(USER, payload={"field": field, "value": value, "old": None}, device_seq=2)
        assert reasons(db, USER, change) == ["pool and quantity are set when the item is created (FR-INV-34)"]


def test_a_pool_has_no_units(db):
    push(
        db,
        USER,
        batch(
            USER, own(USER, type="created", payload={"name": "Bowls", "generic": True, "pool": True, "quantity": 20})
        ),
        now=T0,
    )
    unit = own(USER, entity_id="bowl-1", type="created", payload={"parent_id": "tent-1", "number": "1"}, device_seq=2)
    assert reasons(db, USER, unit) == ["a pool has no units (FR-INV-34)"]

    push(
        db,
        USER,
        batch(USER, own(USER, entity_id="tent-2", type="created", payload={"name": "Stray"}, device_seq=2)),
        now=T0,
    )
    move = own(USER, entity_id="tent-2", payload={"field": "parent_id", "value": "tent-1", "old": None}, device_seq=3)
    assert reasons(db, USER, move) == ["a pool has no units (FR-INV-34)"]


def test_a_pool_moves_by_count(db):
    """Not blocked by the "generic item does not move" rule that applies to every other generic (FR-INV-21)."""
    push(
        db,
        USER,
        batch(
            USER, own(USER, type="created", payload={"name": "Bowls", "generic": True, "pool": True, "quantity": 20})
        ),
        now=T0,
    )
    no_count = own(USER, type="checked_out", payload={"holder_id": "alice"}, device_seq=2)
    assert reasons(db, USER, no_count) == ["a pool moves by count"]
    with_count = own(USER, type="checked_out", payload={"holder_id": "alice", "count": 3}, device_seq=2)
    assert reasons(db, USER, with_count) == []


def test_pool_overdraw_is_accepted_not_blocked(db):
    """Taking more than are in warns in the UI; the server never refuses it (FR-OUT-22)."""
    push(
        db,
        USER,
        batch(USER, own(USER, type="created", payload={"name": "Bowls", "generic": True, "pool": True, "quantity": 3})),
        now=T0,
    )
    out = own(USER, type="checked_out", payload={"holder_id": "alice", "count": 10}, device_seq=2)
    assert reasons(db, USER, out) == []


def test_count_is_refused_off_a_pool(db):
    push(db, USER, batch(USER, own(USER, type="created", payload={"name": "Tent"})), now=T0)
    out = own(USER, type="checked_out", payload={"holder_id": "alice", "count": 1}, device_seq=2)
    assert reasons(db, USER, out) == ["count is only for a pool (FR-OUT-22)"]


def test_a_pool_may_take_a_code(db):
    """The code goes on the container, not a labelled unit — a pool has none (FR-TAG-15)."""
    push(
        db,
        USER,
        batch(
            USER, own(USER, type="created", payload={"name": "Bowls", "generic": True, "pool": True, "quantity": 20})
        ),
        now=T0,
    )
    events.append_server(db, "alice", "code", "ABCDEFGH23", "created", {}, now=T0)
    bind = own(
        USER, entity_type="code", entity_id="ABCDEFGH23", type="code_bound", payload={"item_id": "tent-1"}, device_seq=2
    )
    assert reasons(db, USER, bind) == []


def test_recount_is_only_for_a_pool(db):
    push(db, USER, batch(USER, own(USER, type="created", payload={"name": "Tent"})), now=T0)
    bad = own(USER, type="recounted", payload={"count": 5, "reason": "shelf check"}, device_seq=2)
    assert reasons(db, USER, bad) == ["recount is only for a pool (FR-INV-35)"]

    push(
        db,
        USER,
        batch(
            USER,
            own(
                USER,
                entity_id="bowls",
                type="created",
                payload={"name": "Bowls", "generic": True, "pool": True, "quantity": 20},
                device_seq=2,
            ),
        ),
        now=T0,
    )
    ok = own(USER, entity_id="bowls", type="recounted", payload={"count": 15, "reason": "shelf check"}, device_seq=3)
    assert reasons(db, USER, ok) == []
