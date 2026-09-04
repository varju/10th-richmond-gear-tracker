"""views.py: pure functions over a replayed state. Pools and reservations are exercised here
directly; the rest is through tests/test_assistant.py, which calls these through the assistant.
"""

from __future__ import annotations

from gear_tracker.views import (
    DAY_MS,
    category_blockers,
    codes_for,
    current_code,
    has_gear_out,
    is_pool,
    pool_counts,
    remaining,
    rows,
    what_is_out,
)


def test_is_pool():
    assert is_pool({"pool": True})
    assert not is_pool({"pool": False})
    assert not is_pool({})


def test_pool_counts_owned_in_and_out_by_holder():
    """Owned is in plus every holder's count (FR-INV-36); a holder back at zero is not listed."""
    it = {"pool_in": 4, "pool_out": {"bob": 3, "carol": 0}}
    assert pool_counts(it) == {"owned": 7, "in": 4, "out": [{"holder_id": "bob", "count": 3}]}


def test_pool_counts_with_nothing_out():
    assert pool_counts({"pool_in": 10}) == {"owned": 10, "in": 10, "out": []}


def test_rows_matches_a_pool_to_a_location_filter():
    """FR-INV-25. A pool has no units for search() to filter on location; rows() checks its home."""
    state = {
        "item": {
            "bowls": {"name": "Bowls", "generic": True, "pool": True, "pool_in": 3, "home_location_id": "cold"},
        },
    }
    assert [r["name"] for r in rows(state, location_id="cold")] == ["Bowls"]
    assert rows(state, location_id="warm") == []


def test_rows_matches_a_pool_to_a_status_filter():
    """ "in" means stock on the shelf; "out" means anything checked out; "missing" never matches a pool."""
    state = {
        "item": {
            "bowls": {"name": "Bowls", "generic": True, "pool": True, "pool_in": 3, "pool_out": {"bob": 4}},
            "cups": {"name": "Cups", "generic": True, "pool": True, "pool_in": 0, "pool_out": {}},
        }
    }
    assert [r["name"] for r in rows(state, status="in")] == ["Bowls"]
    assert [r["name"] for r in rows(state, status="out")] == ["Bowls"]
    assert rows(state, status="missing") == []


def test_what_is_out_lists_a_pool_once_per_holder():
    """FR-RPT-11. A pool holder's entry carries a count, not days or an event: a count can be
    the sum of check-outs at different times under different events."""
    state = {
        "item": {
            "bowls": {
                "name": "Bowls",
                "generic": True,
                "pool": True,
                "pool_in": 3,
                "pool_out": {"bob": 4, "carol": 2},
            },
            "tent-1": {
                "name": "Tent",
                "status": "out",
                "holder_id": "bob",
                "since": 1000,
                "movement": {"event": "Fall Camp"},
            },
        },
        "user": {"bob": {"name": "Bob"}, "carol": {"name": "Carol"}},
    }
    report = what_is_out(state, now=1000 + DAY_MS)
    by_holder = {h["holder"]: h["items"] for h in report["holders"]}
    assert by_holder["Bob"] == [
        {"item_id": "tent-1", "name": "Tent", "days": 1, "event": "Fall Camp", "overdue": False},
        # A pool's entry carries the same fields as an ordinary one, for parity with reports.ts,
        # even though days, event, and overdue mean nothing for it (FR-RPT-11).
        {"item_id": "bowls", "name": "Bowls", "days": 0, "event": None, "overdue": False, "count": 4},
    ]
    assert by_holder["Carol"] == [
        {"item_id": "bowls", "name": "Bowls", "days": 0, "event": None, "overdue": False, "count": 2}
    ]
    assert report["total"] == 3
    assert report["overdue"] == 0


def test_what_is_out_skips_a_pool_with_nothing_out():
    state = {"item": {"bowls": {"name": "Bowls", "generic": True, "pool": True, "pool_in": 20, "pool_out": {}}}}
    assert what_is_out(state, now=0) == {"holders": [], "total": 0, "overdue": 0}


def test_what_is_out_skips_a_retired_pool():
    """A retired pool is written off; its holders no longer show as having it out."""
    state = {
        "item": {"bowls": {"name": "Bowls", "generic": True, "pool": True, "retired": True, "pool_out": {"bob": 2}}},
        "user": {"bob": {"name": "Bob"}},
    }
    assert what_is_out(state, now=0) == {"holders": [], "total": 0, "overdue": 0}


def test_remaining_reads_a_pool_lines_done_count_from_pool_reservations():
    """FR-RES-13. pool_reservations accumulates at replay, so this covers two check-outs for the
    same reservation, capped at the line's quantity, not the raw total."""
    state = {
        "item": {
            "bowls": {
                "name": "Bowls",
                "generic": True,
                "pool": True,
                "pool_in": 2,
                "pool_out": {"alice": 8},
                "pool_reservations": {"r-fall": 8},
            }
        },
        "reservation": {
            "r-fall": {
                "event": "Fall Camp",
                "starts": "2026-10-02",
                "ends": "2026-10-04",
                "items": [],
                "generics": [{"item_id": "bowls", "quantity": 4}],
            }
        },
    }
    r = state["reservation"]["r-fall"] | {"id": "r-fall"}
    assert remaining(state, r)["generics"] == [{"item_id": "bowls", "name": "Bowls", "quantity": 4, "done": 4}]


def test_remaining_pool_line_is_not_done_for_a_different_reservation():
    """A repeat camp does not read as packed: another reservation's count, even under the same
    event name, does not count toward this one's (FR-RES-13)."""
    state = {
        "item": {
            "bowls": {
                "name": "Bowls",
                "generic": True,
                "pool": True,
                "pool_in": 6,
                "pool_out": {"alice": 4},
                "pool_reservations": {"r-other": 4},
            }
        },
        "reservation": {
            "r-fall": {
                "event": "Fall Camp",
                "starts": "2026-10-02",
                "ends": "2026-10-04",
                "items": [],
                "generics": [{"item_id": "bowls", "quantity": 4}],
            }
        },
    }
    r = state["reservation"]["r-fall"] | {"id": "r-fall"}
    assert remaining(state, r)["generics"][0]["done"] == 0


def test_remaining_generic_line_does_not_count_a_retired_unit():
    state = {
        "item": {
            "tents": {"name": "4-person tent", "generic": True},
            "t1": {
                "parent_id": "tents",
                "number": "1",
                "status": "out",
                "retired": True,
                "movement": {"event": "Fall Camp", "reservation_id": "r-fall"},
            },
            "t2": {
                "parent_id": "tents",
                "number": "2",
                "status": "out",
                "movement": {"event": "Fall Camp", "reservation_id": "r-fall"},
            },
        },
        "reservation": {
            "r-fall": {
                "event": "Fall Camp",
                "starts": "2026-10-02",
                "ends": "2026-10-04",
                "items": [],
                "generics": [{"item_id": "tents", "quantity": 2}],
            }
        },
    }
    r = state["reservation"]["r-fall"] | {"id": "r-fall"}
    assert remaining(state, r)["generics"][0]["done"] == 1


def test_remaining_does_not_tick_a_repeat_event_name_from_a_different_reservation():
    """Two reservations can share an event name (a camp held again next year); a check-out under
    the first must not tick the second (FR-RES-13)."""
    state = {
        "item": {
            "tents": {"name": "4-person tent", "generic": True},
            "t1": {
                "parent_id": "tents",
                "number": "1",
                "status": "out",
                "movement": {"event": "Fall Camp", "reservation_id": "r-2025"},
            },
        },
        "reservation": {
            "r-2025": {
                "event": "Fall Camp",
                "starts": "2025-10-02",
                "ends": "2025-10-04",
                "items": [],
                "generics": [{"item_id": "tents", "quantity": 1}],
            },
            "r-2026": {
                "event": "Fall Camp",
                "starts": "2026-10-02",
                "ends": "2026-10-04",
                "items": [],
                "generics": [{"item_id": "tents", "quantity": 1}],
            },
        },
    }
    r2026 = state["reservation"]["r-2026"] | {"id": "r-2026"}
    assert remaining(state, r2026)["generics"][0]["done"] == 0


# --- rows: a pool is its own kind --------------------------------------------------------


def test_rows_gives_a_pool_its_own_kind_and_counts_with_no_units():
    state = {"item": {"bowls": {"name": "Bowls", "generic": True, "pool": True, "pool_in": 5}}}
    row = rows(state)[0]
    assert row["kind"] == "pool"
    assert row["counts"] == {"owned": 5, "in": 5, "out": []}
    assert "units" not in row


# --- codes_for and current_code -----------------------------------------------------------


def test_codes_for_lists_the_current_code_first_and_skips_released_ones():
    state = {
        "item": {"stove": {"name": "Camp stove"}, "dup": {"name": "Stove", "merged_into": "stove"}},
        "code": {
            "AAAAAAAAAA": {"item_id": "stove", "bound_at": 1000},
            "BBBBBBBBBB": {"item_id": "dup", "bound_at": 2000},
            "CCCCCCCCCC": {"item_id": None, "bound_at": 3000},
            "DDDDDDDDDD": {"item_id": "other", "bound_at": 4000},
        },
    }
    assert codes_for(state, "stove") == ["BBBBBBBBBB", "AAAAAAAAAA"]
    assert codes_for(state, "other") == ["DDDDDDDDDD"]
    assert codes_for(state, "dup") == []


def test_current_code_breaks_a_tie_on_bound_at_by_the_larger_id():
    state = {
        "item": {"stove": {"name": "Camp stove"}},
        "code": {
            "AAAAAAAAAA": {"item_id": "stove", "bound_at": 1000},
            "ZZZZZZZZZZ": {"item_id": "stove", "bound_at": 1000},
        },
    }
    assert current_code(state, "stove") == "ZZZZZZZZZZ"


# --- category_blockers: a deleted category still sees what pointed at it -----------------


def test_category_blockers_finds_an_item_after_its_category_is_deleted():
    state = {
        "item": {"stove": {"name": "Camp stove", "category_ids": ["camping"]}},
        "category": {"camping": {"name": "Camping", "deleted": True}},
    }
    assert [it["name"] for it in category_blockers(state, "camping")] == ["Camp stove"]


# --- has_gear_out: an ordinary item, a generic's units, and a pool -----------------------


def test_has_gear_out_for_an_ordinary_item():
    assert has_gear_out({}, {"status": "out"})
    assert not has_gear_out({}, {"status": "in"})


def test_has_gear_out_for_a_pool():
    it = {"id": "bowls", "generic": True, "pool": True, "pool_out": {"bob": 2}}
    assert has_gear_out({}, it)
    assert not has_gear_out({}, {"id": "bowls", "generic": True, "pool": True, "pool_out": {"bob": 0}})


def test_has_gear_out_for_a_generic_with_a_unit_out():
    state = {
        "item": {
            "tents": {"name": "4-person tent", "generic": True},
            "t1": {"parent_id": "tents", "number": "1", "status": "out"},
        }
    }
    assert has_gear_out(state, state["item"]["tents"] | {"id": "tents"})
    state["item"]["t1"]["status"] = "in"
    assert not has_gear_out(state, state["item"]["tents"] | {"id": "tents"})
