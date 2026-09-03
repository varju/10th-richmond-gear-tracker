"""conflicts.py: reservation clashes and near-clash hints, over a plain state dict. The vector
suite in test_reservation_vectors.py covers `conflicts` in depth; these are the pool and
near-clash rules that do not (yet) have their own shared vectors.
"""

from __future__ import annotations

from gear_tracker.conflicts import conflicts, nearby


def _tents_state() -> dict:
    return {
        "item": {
            "tents": {"name": "4-person tent", "generic": True},
            "t1": {"parent_id": "tents", "number": "1", "status": "in", "holder_id": None},
        },
        "reservation": {
            "r-fall": {
                "event": "Fall Camp",
                "starts": "2026-10-02",
                "ends": "2026-10-04",
                "items": ["t1"],
                "generics": [{"item_id": "tents", "quantity": 1}],
            }
        },
    }


def test_a_pool_conflicts_against_what_it_owns_not_a_count_of_units():
    state = {
        "item": {"bowls": {"name": "Bowls", "generic": True, "pool": True, "pool_in": 10, "pool_out": {}}},
        "reservation": {
            "r-fall": {
                "event": "Fall Camp",
                "starts": "2026-10-02",
                "ends": "2026-10-04",
                "items": [],
                "generics": [{"item_id": "bowls", "quantity": 6}],
            }
        },
    }
    draft = {"event": "Cubs", "starts": "2026-10-02", "ends": "2026-10-04", "items": [], "generics": []}

    fits = conflicts(state, {**draft, "generics": [{"item_id": "bowls", "quantity": 4}]})
    assert fits == []

    too_many = conflicts(state, {**draft, "generics": [{"item_id": "bowls", "quantity": 5}]})
    assert too_many == [{"id": "r-fall", "event": "Fall Camp", "detail": "11 × Bowls, we have 10"}]


def test_nearby_names_a_camp_within_seven_days_sharing_a_line_not_one_overlapping():
    state = _tents_state()

    # Four days after Fall Camp ends: near, not overlapping.
    near = nearby(
        state,
        {
            "event": "Winter Prep",
            "starts": "2026-10-08",
            "ends": "2026-10-09",
            "items": [],
            "generics": [{"item_id": "tents", "quantity": 1}],
        },
    )
    assert near == {"tents": [{"event": "Fall Camp", "detail": "2026-10-02 – 2026-10-04"}]}

    # Eight days after Fall Camp ends: outside the window.
    far = nearby(
        state,
        {
            "event": "Spring",
            "starts": "2026-10-13",
            "ends": "2026-10-14",
            "items": [],
            "generics": [{"item_id": "tents", "quantity": 1}],
        },
    )
    assert far == {}


def test_nearby_is_empty_for_an_overlap_conflicts_handles_that_instead():
    state = _tents_state()
    draft = {"event": "Same time", "starts": "2026-10-02", "ends": "2026-10-04", "items": ["t1"], "generics": []}
    assert nearby(state, draft) == {}


def test_nearby_names_an_item_too():
    state = _tents_state()
    near = nearby(
        state, {"event": "Winter Prep", "starts": "2026-10-08", "ends": "2026-10-09", "items": ["t1"], "generics": []}
    )
    assert near == {"t1": [{"event": "Fall Camp", "detail": "2026-10-02 – 2026-10-04"}]}
