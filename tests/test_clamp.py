"""The clamp is pure. Hammer it here; the database tests only check it is wired in."""

from __future__ import annotations

import pytest

from gear_tracker.events import clamp


@pytest.mark.parametrize(
    ("occurred", "offset", "received", "previous", "want"),
    [
        (100, 0, 200, None, 100),  # plausible, untouched
        (100, 50, 200, None, 150),  # offset applied
        (100, -50, 200, None, 50),  # negative offset applied
        (300, 0, 200, None, 200),  # device ahead of the server: ceiling
        (150, 100, 200, None, 200),  # offset pushes past arrival: ceiling
        (100, 0, 200, 120, 120),  # before the device's last event: floor
        (100, 0, 200, 100, 100),  # equal to the floor is fine
        (300, 0, 200, 250, 250),  # both apply; floor wins over ceiling
        (100, 0, 90, 95, 95),  # server clock went backwards: floor still wins
    ],
)
def test_clamp(occurred, offset, received, previous, want):
    assert clamp(occurred, offset, received, previous) == want


def test_a_fast_clock_two_days_late_is_not_caught_by_the_clamp_alone():
    """Documented in architecture.md: the clamp catches absurd values, not likely ones."""
    hour = 3_600_000
    day = 24 * hour
    friday = 1_000 * day
    three_hours_fast = friday + 3 * hour
    sunday = friday + 2 * day
    assert clamp(three_hours_fast, 0, sunday, friday - day) == three_hours_fast
    # The offset is what fixes it.
    assert clamp(three_hours_fast, -3 * hour, sunday, friday - day) == friday
