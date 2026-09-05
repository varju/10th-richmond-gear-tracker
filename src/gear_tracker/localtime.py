"""The group's own calendar day (NFR-DATA-12).

Timestamps on the log are UTC milliseconds. A person picking a date means a
day where the group is, so anything that turns a date into a span of
milliseconds does it here, once.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("America/Vancouver")
"""Where the group is. A day off a calendar, or off a date field, is a day here, not UTC."""


def start_of_day(day: date) -> int:
    """The first millisecond of a local day, in UTC milliseconds."""
    return int(datetime.combine(day, time.min, tzinfo=ZONE).timestamp() * 1000)


def day_span(first: date | None, last: date | None) -> tuple[int | None, int | None]:
    """An inclusive range of local days as a half-open span of milliseconds.

    Either end may be missing, which means no bound at that end. `last` runs to
    the end of its day, so a single-day range is not empty.
    """
    return (
        None if first is None else start_of_day(first),
        None if last is None else start_of_day(last + timedelta(days=1)),
    )
