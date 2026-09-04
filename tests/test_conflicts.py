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


def test_a_draft_naming_only_a_unit_is_still_checked_against_the_generics_stock():
    # Two tents owned, both reserved by count. A draft naming one unit, with no generics line
    # of its own, must still be caught (FR-RES-15): the check cannot depend on the draft
    # reserving the generic by count.
    state = {
        "item": {
            "tents": {"name": "4-person tent", "generic": True},
            "t1": {"parent_id": "tents", "number": "1", "status": "in", "holder_id": None},
            "t2": {"parent_id": "tents", "number": "2", "status": "in", "holder_id": None},
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
    draft = {"event": "Cubs", "starts": "2026-10-02", "ends": "2026-10-04", "items": ["t1"], "generics": []}
    assert conflicts(state, draft) == [{"id": "r-fall", "event": "Fall Camp", "detail": "3 × 4-person tent, we have 2"}]


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


def test_nearby_marks_a_generic_only_when_the_near_camps_would_leave_us_short():
    state = {
        "item": {
            "tents": {"name": "4-person tent", "generic": True},
            "t1": {"parent_id": "tents", "number": "1", "status": "in", "holder_id": None},
            "t2": {"parent_id": "tents", "number": "2", "status": "in", "holder_id": None},
            "t3": {"parent_id": "tents", "number": "3", "status": "in", "holder_id": None},
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

    # Four days later, Winter Prep wants 1 more: 3 needed, 3 owned. Enough to go around.
    fits = nearby(
        state,
        {
            "event": "Winter Prep",
            "starts": "2026-10-08",
            "ends": "2026-10-09",
            "items": [],
            "generics": [{"item_id": "tents", "quantity": 1}],
        },
    )
    assert fits == {}

    # Winter Prep wants 2 more: 4 needed, only 3 owned. Now it is worth a warning.
    short = nearby(
        state,
        {
            "event": "Winter Prep",
            "starts": "2026-10-08",
            "ends": "2026-10-09",
            "items": [],
            "generics": [{"item_id": "tents", "quantity": 2}],
        },
    )
    assert short == {"tents": [{"event": "Fall Camp", "detail": "2026-10-02 – 2026-10-04"}]}


def test_nearby_weighs_each_near_camp_against_the_draft_alone():
    state = {
        "item": {
            "tents": {"name": "4-person tent", "generic": True},
            "t1": {"parent_id": "tents", "number": "1", "status": "in", "holder_id": None},
            "t2": {"parent_id": "tents", "number": "2", "status": "in", "holder_id": None},
            "t3": {"parent_id": "tents", "number": "3", "status": "in", "holder_id": None},
        },
        "reservation": {
            "r-before": {
                "event": "Cub Camp",
                "starts": "2026-09-26",
                "ends": "2026-09-27",
                "items": [],
                "generics": [{"item_id": "tents", "quantity": 2}],
            },
            "r-after": {
                "event": "Winter Prep",
                "starts": "2026-10-09",
                "ends": "2026-10-10",
                "items": [],
                "generics": [{"item_id": "tents", "quantity": 2}],
            },
        },
    }
    draft = {"event": "Fall Camp", "starts": "2026-10-02", "ends": "2026-10-04", "items": []}

    # One more tent between them: 3 of 3 with either neighbour. The neighbours are a fortnight
    # apart and never share tents with each other, so they are not added together.
    assert nearby(state, {**draft, "generics": [{"item_id": "tents", "quantity": 1}]}) == {}

    # Two more is short against each of them.
    short = nearby(state, {**draft, "generics": [{"item_id": "tents", "quantity": 2}]})
    assert [n["event"] for n in short["tents"]] == ["Cub Camp", "Winter Prep"]
