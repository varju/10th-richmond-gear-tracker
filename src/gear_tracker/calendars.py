"""Calendar feeds an Admin points at the group's own calendar (FR-RES-20).

The group's events live in a handful of ICS feeds. An Admin pastes the feed
URLs in here; the server fetches and parses them, keeping only events from
7 days ago to 180 days ahead, and ships the names and dates to every device
through sync so the reservation form and a scanning session can suggest them
offline. Events are not entities on the log -- they are reference data the
server owns, the same shape as the mail settings.

A feed's URL can carry a private token (a "secret address" a calendar
provider hands out). Like the mail password (mail.py, migration 0006), it
lives only in the `calendar_feeds` table, is never written to the event log,
and is never sent to a device (NFR-SEC-10). An Admin is shown it redacted to
host and path.

Refreshed hourly from a background thread started with the app
(`start_background_refresh`), right after a feed is added, and on demand
("Refresh now"). A failed fetch records the error and keeps the events from
the last successful fetch.
"""

from __future__ import annotations

import hashlib
import logging
import sqlite3
import threading
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, cast
from urllib.error import URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from dateutil.rrule import rrulestr
from icalendar import Calendar
from pydantic import StringConstraints

from gear_tracker.db import connect
from gear_tracker.errors import NotFound
from gear_tracker.events import Strict, now_ms
from gear_tracker.ulid import new_ulid

logger = logging.getLogger(__name__)

TIMEOUT_S = 15
"""An Admin, or the refresh thread, is waiting; better a clear failure than a hang (mirrors mail.TIMEOUT_S)."""

LOOKBACK_DAYS = 7
LOOKAHEAD_DAYS = 180

REFRESH_INTERVAL_S = 3600.0

ZONE = ZoneInfo("America/Vancouver")
"""Where the group is (NFR-DATA-12). A day off the calendar is a day here, not UTC."""

FeedUrl = Annotated[str, StringConstraints(min_length=1, max_length=2000, pattern=r"^https?://")]
FeedLabel = Annotated[str, StringConstraints(max_length=200)]


class FeedInput(Strict):
    url: FeedUrl
    label: FeedLabel = ""


def redact(url: str) -> str:
    """Host and path only. The query string is where a private token lives (NFR-SEC-10)."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _row_to_feed(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "label": row["label"],
        "url_redacted": redact(row["url"]),
        "added_at": row["added_at"],
        "last_fetched_at": row["last_fetched_at"],
        "last_error": row["last_error"],
    }


def list_feeds(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM calendar_feeds ORDER BY added_at").fetchall()
    return [_row_to_feed(row) for row in rows]


def add_feed(conn: sqlite3.Connection, body: FeedInput, now: int | None = None) -> dict[str, Any]:
    """Add a feed and fetch it once right away, so an Admin sees at a glance whether the URL works."""
    now = now_ms() if now is None else now
    feed_id = new_ulid(now)
    conn.execute(
        "INSERT INTO calendar_feeds (id, url, label, added_at) VALUES (?, ?, ?, ?)",
        (feed_id, body.url, body.label, now),
    )
    return refresh_feed(conn, feed_id, now=now)


def remove_feed(conn: sqlite3.Connection, feed_id: str) -> None:
    cur = conn.execute("DELETE FROM calendar_feeds WHERE id = ?", (feed_id,))
    if cur.rowcount == 0:
        raise NotFound("no such calendar feed")


def _fetch(url: str) -> str:
    request = Request(url, headers={"User-Agent": "gear-tracker-calendar/1"})
    with urlopen(request, timeout=TIMEOUT_S) as response:
        return response.read().decode("utf-8", errors="replace")


def refresh_feed(conn: sqlite3.Connection, feed_id: str, now: int | None = None) -> dict[str, Any]:
    """Fetch and parse one feed. A failure records `last_error` and keeps the events already stored."""
    now = now_ms() if now is None else now
    row = conn.execute("SELECT * FROM calendar_feeds WHERE id = ?", (feed_id,)).fetchone()
    if row is None:
        raise NotFound("no such calendar feed")
    try:
        text = _fetch(row["url"])
        found = parse_ics(text, now)
    except (URLError, OSError, ValueError) as exc:
        message = str(exc) or repr(exc)
        conn.execute("UPDATE calendar_feeds SET last_error = ? WHERE id = ?", (message, feed_id))
        logger.warning("calendar feed %s could not be fetched: %s", feed_id, exc)
        return _row_to_feed(conn.execute("SELECT * FROM calendar_feeds WHERE id = ?", (feed_id,)).fetchone())

    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM calendar_events WHERE feed_id = ?", (feed_id,))
        conn.executemany(
            "INSERT OR REPLACE INTO calendar_events (feed_id, uid, summary, starts, ends, all_day) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [(feed_id, e["uid"], e["summary"], e["starts"], e["ends"], int(e["all_day"])) for e in found],
        )
        conn.execute("UPDATE calendar_feeds SET last_fetched_at = ?, last_error = NULL WHERE id = ?", (now, feed_id))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return _row_to_feed(conn.execute("SELECT * FROM calendar_feeds WHERE id = ?", (feed_id,)).fetchone())


def refresh_all(conn: sqlite3.Connection, now: int | None = None) -> list[dict[str, Any]]:
    """Every feed, one at a time. One bad feed does not stop the rest."""
    now = now_ms() if now is None else now
    feeds = []
    for row in conn.execute("SELECT id FROM calendar_feeds ORDER BY added_at").fetchall():
        feeds.append(refresh_feed(conn, row["id"], now=now))
    return feeds


def upcoming_events(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """What a device gets at sync: every kept event, across every feed, oldest first."""
    rows = conn.execute("SELECT uid, summary, starts, ends, all_day FROM calendar_events ORDER BY starts").fetchall()
    return [
        {
            "uid": row["uid"],
            "summary": row["summary"],
            "starts": row["starts"],
            "ends": row["ends"],
            "all_day": bool(row["all_day"]),
        }
        for row in rows
    ]


# --- parsing -------------------------------------------------------------------------------


def _local_date(value: datetime) -> date:
    """The calendar day an instant fell on where the group is (NFR-DATA-12).

    A naive value (no TZID, "floating" in the ICS sense) is read as already
    local, which is what most small feeds mean by it.
    """
    if value.tzinfo is not None:
        value = value.astimezone(ZONE)
    return value.date()


def _duration(dtstart: Any, dtend: Any | None) -> timedelta | None:
    if dtend is None:
        return None
    return dtend - dtstart


def _exdates(component: Any) -> set[Any]:
    raw = component.get("exdate")
    if raw is None:
        return set()
    lists = raw if isinstance(raw, list) else [raw]
    out: set[Any] = set()
    for entry in lists:
        for item in getattr(entry, "dts", [entry]):
            value = getattr(item, "dt", item)
            out.add(value)
    return out


def _occurrences(component: Any, window_start: date, window_end: date) -> list[tuple[Any, Any]]:
    """One (start, end) pair per occurrence that could touch the window, single or recurring.

    Recurrence is expanded with dateutil's RRULE parser, which `icalendar`
    already depends on, rather than a second package. A rule dateutil cannot
    read falls back to the one instance in the feed rather than being dropped.
    """
    dtstart_prop = component.get("dtstart")
    dtstart = dtstart_prop.dt
    dtend_prop = component.get("dtend")
    duration = _duration(dtstart, dtend_prop.dt if dtend_prop is not None else None)

    def end_of(start: Any) -> Any:
        return start + duration if duration is not None else start

    rrule_prop = component.get("rrule")
    if rrule_prop is None:
        return [(dtstart, end_of(dtstart))]

    try:
        rule_str = f"DTSTART:{dtstart_prop.to_ical().decode()}\nRRULE:{rrule_prop.to_ical().decode()}"
        rule = rrulestr(rule_str)
    except ValueError, TypeError:
        logger.warning("could not parse a recurrence rule; keeping one instance")
        return [(dtstart, end_of(dtstart))]

    all_day = isinstance(dtstart, date) and not isinstance(dtstart, datetime)
    aware = isinstance(dtstart, datetime) and dtstart.tzinfo is not None
    pad = timedelta(days=1)
    between_start = datetime.combine(window_start - pad, datetime.min.time())
    between_end = datetime.combine(window_end + pad, datetime.min.time())
    if aware:
        between_start, between_end = between_start.replace(tzinfo=UTC), between_end.replace(tzinfo=UTC)
    exdates = _exdates(component)

    out: list[tuple[Any, Any]] = []
    for occurrence in rule.between(between_start, between_end, inc=True):
        start = occurrence.date() if all_day else occurrence
        if start in exdates or occurrence in exdates:
            continue
        out.append((start, end_of(start)))
    return out


def _uid_of(component: Any, summary: str, dtstart: Any) -> str:
    raw = component.get("uid")
    if raw:
        return str(raw)
    # Some feeds omit UID. A stable stand-in, so a re-fetch replaces the same row rather than
    # piling up duplicates.
    return hashlib.sha1(f"{summary}|{dtstart}".encode()).hexdigest()


def parse_ics(text: str, now: int) -> list[dict[str, Any]]:
    """Every event, and every occurrence of a recurring one, touching the keep window.

    The window is 7 days ago to 180 days ahead of `now`, measured in the
    group's own calendar day (NFR-DATA-12).
    """
    calendar = Calendar.from_ical(text)
    today = datetime.fromtimestamp(now / 1000, tz=UTC).astimezone(ZONE).date()
    window_start = today - timedelta(days=LOOKBACK_DAYS)
    window_end = today + timedelta(days=LOOKAHEAD_DAYS)

    out: list[dict[str, Any]] = []
    for component in calendar.walk("VEVENT"):
        if component.get("dtstart") is None:
            continue
        summary = str(component.get("summary", ""))
        dtstart = cast(Any, component["dtstart"]).dt
        all_day = isinstance(dtstart, date) and not isinstance(dtstart, datetime)
        uid = _uid_of(component, summary, dtstart)
        for start, end in _occurrences(component, window_start, window_end):
            if all_day:
                starts, ends = start, end
                if ends > starts:
                    ends = ends - timedelta(days=1)  # DTEND on an all-day event is exclusive
            else:
                starts, ends = _local_date(start), _local_date(end)
            if starts > window_end or ends < window_start:
                continue
            out.append(
                {
                    "uid": uid,
                    "summary": summary,
                    "starts": starts.isoformat(),
                    "ends": ends.isoformat(),
                    "all_day": all_day,
                }
            )
    return out


# --- background refresh ---------------------------------------------------------------------


def start_background_refresh(db_path: Any, interval_s: float = REFRESH_INTERVAL_S) -> Callable[[], None]:
    """Refresh every feed hourly, on its own thread and its own connection.

    Started from app.py's lifespan, so it runs for as long as the server does
    and stops when it shuts down. Harmless with no feeds configured, which is
    every test database: each tick finds nothing to fetch and returns at once.
    Returns a function that stops the thread and waits for it to exit.
    """
    stop = threading.Event()

    def loop() -> None:
        conn = connect(db_path)
        try:
            while True:
                try:
                    refresh_all(conn)
                except Exception:
                    logger.exception("calendar refresh failed")
                if stop.wait(interval_s):
                    return
        finally:
            conn.close()

    thread = threading.Thread(target=loop, name="calendar-refresh", daemon=True)
    thread.start()

    def stop_and_join() -> None:
        stop.set()
        thread.join(timeout=5)

    return stop_and_join
