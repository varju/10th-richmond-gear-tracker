"""The event log: what gets in, and in what order it is read back.

Every write to the system is an INSERT here. Nothing updates or deletes;
the database enforces that with triggers. See docs/architecture.md.

Timestamps are integer milliseconds since the Unix epoch, UTC.
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from gear_tracker.ulid import is_ulid

ENTITY_TYPES = frozenset({"item", "user", "location", "code", "reservation", "repair", "setting"})

# What the log understands today. Later milestones add to this; replay must
# grow with it, and the two replays must agree (NFR-MAINT-04).
EVENT_TYPES = frozenset({"created", "field_changed", "note_added", "note_corrected", "checked_out", "checked_in"})
ITEM_ONLY = frozenset({"checked_out", "checked_in"})


class Rejected(ValueError):
    """The server will not take this event. The reason goes back to the device (NFR-DATA-01)."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class Event:
    id: str
    entity_type: str
    entity_id: str
    type: str
    actor_id: str
    device_id: str
    device_seq: int
    occurred_at: int
    clock_offset: int
    effective_at: int
    received_at: int
    seq: int
    payload: dict[str, Any]

    @property
    def replay_key(self) -> tuple[int, str, int]:
        return replay_key(self)


def replay_key(event: Event) -> tuple[int, str, int]:
    """Total order over the log. Both replays sort by this; see Ordering."""
    return (event.effective_at, event.device_id, event.device_seq)


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def clamp(occurred_at: int, clock_offset: int, received_at: int, previous_effective_at: int | None) -> int:
    """Bound a corrected device time. See architecture.md, Ordering.

    Never after arrival; never before the device's previous event. If the two
    disagree (a server clock stepped backwards) the floor wins, because
    causality within a device is the rule replay depends on.
    """
    effective = min(occurred_at + clock_offset, received_at)
    if previous_effective_at is not None:
        effective = max(effective, previous_effective_at)
    return effective


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _non_empty_str(value: object) -> bool:
    return isinstance(value, str) and value != ""


def validate(incoming: dict[str, Any]) -> None:
    """Refuse what the log cannot hold. Raises Rejected with a reason."""
    if not is_ulid(incoming.get("id")):
        raise Rejected("id is not a ULID")
    if incoming.get("entity_type") not in ENTITY_TYPES:
        raise Rejected("unknown entity_type")
    if not _non_empty_str(incoming.get("entity_id")):
        raise Rejected("entity_id is required")
    if incoming.get("type") not in EVENT_TYPES:
        raise Rejected("unknown event type")
    if incoming["type"] in ITEM_ONLY and incoming["entity_type"] != "item":
        raise Rejected(f"{incoming['type']} applies only to items")
    if not _non_empty_str(incoming.get("actor_id")):
        raise Rejected("actor_id is required")
    if not _non_empty_str(incoming.get("device_id")):
        raise Rejected("device_id is required")
    if not _is_int(incoming.get("device_seq")) or incoming["device_seq"] < 1:
        raise Rejected("device_seq must be a positive integer")
    if not _is_int(incoming.get("occurred_at")):
        raise Rejected("occurred_at must be an integer (ms since epoch)")
    if not _is_int(incoming.get("clock_offset")):
        raise Rejected("clock_offset must be an integer (ms)")
    if not isinstance(incoming.get("payload"), dict):
        raise Rejected("payload must be a JSON object")


def append(conn: sqlite3.Connection, incoming: dict[str, Any], received_at: int | None = None) -> Event:
    """Take one event from a device. Idempotent on id.

    One transaction: the clamp reads the device's last event and the insert
    assigns seq. A retry after a dropped connection finds the id already
    stored and returns that row unchanged.
    """
    validate(incoming)
    if received_at is None:
        received_at = now_ms()

    conn.execute("BEGIN IMMEDIATE")
    try:
        existing = get(conn, incoming["id"])
        if existing is not None:
            conn.execute("COMMIT")
            return existing

        previous = conn.execute(
            "SELECT device_seq, effective_at FROM events WHERE device_id = ? ORDER BY device_seq DESC LIMIT 1",
            (incoming["device_id"],),
        ).fetchone()
        if previous is not None and incoming["device_seq"] <= previous["device_seq"]:
            raise Rejected(f"device_seq {incoming['device_seq']} is not above the last seen, {previous['device_seq']}")

        effective_at = clamp(
            incoming["occurred_at"],
            incoming["clock_offset"],
            received_at,
            previous["effective_at"] if previous is not None else None,
        )
        cursor = conn.execute(
            """
            INSERT INTO events (id, entity_type, entity_id, type, actor_id, device_id, device_seq,
                                occurred_at, clock_offset, effective_at, received_at, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                incoming["id"],
                incoming["entity_type"],
                incoming["entity_id"],
                incoming["type"],
                incoming["actor_id"],
                incoming["device_id"],
                incoming["device_seq"],
                incoming["occurred_at"],
                incoming["clock_offset"],
                effective_at,
                received_at,
                dump_payload(incoming["payload"]),
            ),
        )
        stored = get(conn, incoming["id"])
        assert stored is not None and stored.seq == cursor.lastrowid
        conn.execute("COMMIT")
        return stored
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def dump_payload(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def from_row(row: sqlite3.Row) -> Event:
    return Event(
        id=row["id"],
        entity_type=row["entity_type"],
        entity_id=row["entity_id"],
        type=row["type"],
        actor_id=row["actor_id"],
        device_id=row["device_id"],
        device_seq=row["device_seq"],
        occurred_at=row["occurred_at"],
        clock_offset=row["clock_offset"],
        effective_at=row["effective_at"],
        received_at=row["received_at"],
        seq=row["seq"],
        payload=json.loads(row["payload"]),
    )


def get(conn: sqlite3.Connection, event_id: str) -> Event | None:
    row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    return from_row(row) if row is not None else None


def in_replay_order(
    conn: sqlite3.Connection, entity_type: str | None = None, entity_id: str | None = None
) -> Iterator[Event]:
    """The log, or one entity's slice of it, in the order replay reads it."""
    if entity_type is None:
        rows = conn.execute("SELECT * FROM events ORDER BY effective_at, device_id, device_seq")
    else:
        rows = conn.execute(
            "SELECT * FROM events WHERE entity_type = ? AND entity_id = ? ORDER BY effective_at, device_id, device_seq",
            (entity_type, entity_id),
        )
    for row in rows:
        yield from_row(row)


def since(conn: sqlite3.Connection, cursor: int, limit: int = 1000) -> list[Event]:
    """Events after a sync cursor, in seq order. This is what pull returns."""
    rows = conn.execute("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", (cursor, limit))
    return [from_row(r) for r in rows]
