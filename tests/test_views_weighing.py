"""Weighing, read from state a device may have written badly (FR-INV-62, FR-INV-69)."""

from __future__ import annotations

import pytest

from gear_tracker import views

LB20 = {"value": 20, "unit": "lb"}
LB18 = {"value": 18, "unit": "lb"}


def state(**fields):
    return {"item": {"tank": {"name": "Tank", **fields}}}


def tank(s):
    it = views.item(s, "tank")
    assert it is not None
    return it


def left(**fields):
    s = state(**fields)
    return views.amount_left(s, tank(s))


@pytest.mark.parametrize(
    "fields",
    [
        {"empty_weight": LB18, "capacity": {"value": 0, "unit": "lb"}},
        {"empty_weight": LB18, "capacity": {"value": -5, "unit": "lb"}},
        {"empty_weight": LB18, "capacity": {"value": "20", "unit": "lb"}},
        {"empty_weight": LB18, "capacity": {"value": float("nan"), "unit": "lb"}},
        {"empty_weight": LB18, "capacity": {"value": 20, "unit": "stone"}},
        {"empty_weight": {"value": True, "unit": "lb"}, "capacity": LB20},
        {"empty_weight": {"unit": "lb"}, "capacity": LB20},
        {"empty_weight": "heavy", "capacity": LB20},
    ],
)
def test_a_malformed_weight_means_not_weighed(fields):
    s = state(**fields, reading={"full": True, "at": 1})
    assert views.weighing(s, tank(s)) is None
    assert views.amount_left(s, tank(s)) is None


@pytest.mark.parametrize(
    "reading", ["x", 5, {"value": "9", "unit": "lb", "at": 1}, {"value": 9, "unit": "oz", "at": 1}]
)
def test_a_malformed_reading_shows_nothing(reading):
    assert left(empty_weight=LB18, capacity=LB20, reading=reading) is None


def test_a_stale_reading_shows_nothing():
    assert left(empty_weight=LB18, capacity=LB20, reading={"full": True, "at": 1, "stale": True}) is None
    assert left(empty_weight=LB18, capacity=LB20, reading={"full": True, "at": 1})["percent"] == 100
