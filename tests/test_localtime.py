"""A date a person picked is a day where the group is, not a day in UTC (NFR-DATA-12)."""

from __future__ import annotations

from datetime import date

from gear_tracker.localtime import day_span, start_of_day


def test_a_day_starts_at_local_midnight():
    # 2025-09-01 00:00 in Vancouver is 07:00 UTC: seven hours after the UTC day began.
    assert start_of_day(date(2025, 9, 1)) == 1_756_710_000_000


def test_a_span_runs_to_the_end_of_its_last_day():
    """One day is a whole day, not an empty range."""
    assert day_span(date(2025, 9, 1), date(2025, 9, 1)) == (
        start_of_day(date(2025, 9, 1)),
        start_of_day(date(2025, 9, 2)),
    )


def test_a_day_follows_the_clock_change():
    """The Sunday the clocks go back is 25 hours long, and the day after it is not."""
    assert start_of_day(date(2025, 11, 3)) - start_of_day(date(2025, 11, 2)) == 25 * 3_600_000
    assert start_of_day(date(2025, 11, 4)) - start_of_day(date(2025, 11, 3)) == 24 * 3_600_000


def test_either_end_may_be_missing():
    assert day_span(None, None) == (None, None)
    assert day_span(date(2025, 9, 1), None) == (start_of_day(date(2025, 9, 1)), None)
    assert day_span(None, date(2025, 9, 1)) == (None, start_of_day(date(2025, 9, 2)))
