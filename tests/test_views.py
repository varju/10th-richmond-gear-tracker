"""views.py: pure functions over a replayed state. Pools only (FR-INV-34); the rest is
exercised through tests/test_assistant.py, which calls these through the assistant.
"""

from __future__ import annotations

from gear_tracker.views import DAY_MS, is_pool, pool_counts, what_is_out


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
        {"item_id": "bowls", "name": "Bowls", "count": 4},
    ]
    assert by_holder["Carol"] == [{"item_id": "bowls", "name": "Bowls", "count": 2}]
    assert report["total"] == 3
    assert report["overdue"] == 0


def test_what_is_out_skips_a_pool_with_nothing_out():
    state = {"item": {"bowls": {"name": "Bowls", "generic": True, "pool": True, "pool_in": 20, "pool_out": {}}}}
    assert what_is_out(state, now=0) == {"holders": [], "total": 0, "overdue": 0}
