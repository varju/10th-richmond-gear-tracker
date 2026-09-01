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
from typing import Annotated, Any, Literal, get_args

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    ValidationError,
    model_validator,
)

from gear_tracker.replay import DERIVED_FIELDS
from gear_tracker.ulid import is_ulid

EntityType = Literal["item", "user", "location", "code", "reservation", "repair", "setting"]
ENTITY_TYPES = frozenset(get_args(EntityType))


class Rejected(ValueError):
    """The server will not take this event. The reason goes back to the device (NFR-DATA-01)."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason

    @classmethod
    def from_validation(cls, exc: ValidationError) -> Rejected:
        """One reason, the first one. A device shows it to a person; a list would not help."""
        first = exc.errors()[0]
        msg = first["msg"].removeprefix("Value error, ")
        parts = [str(part) for part in first["loc"]]
        if parts and parts[0] in EVENT_TYPES:
            parts = parts[1:]  # the union member's tag is not a field the device sent
        loc = ".".join(parts)
        return cls(f"{loc}: {msg}" if loc else msg)


def _ulid(value: str) -> str:
    if not is_ulid(value):
        raise ValueError("not a ULID")
    return value


def _not_derived(value: str) -> str:
    if value in DERIVED_FIELDS:
        raise ValueError(f"{value} is derived from movements, not set directly")
    return value


Ulid = Annotated[str, AfterValidator(_ulid)]
NonEmpty = Annotated[str, StringConstraints(min_length=1)]


class Strict(BaseModel):
    """No coercion: "1" is not 1 and True is not 1. What the device sent is what we judge."""

    model_config = ConfigDict(strict=True, frozen=True)


class Payload(Strict):
    """Payloads keep keys we do not know about. A newer client must not lose data to an older server."""

    model_config = ConfigDict(strict=True, frozen=True, extra="allow")


class FieldChange(Payload):
    field: Annotated[NonEmpty, AfterValidator(_not_derived)]
    value: Any


class NoteText(Payload):
    text: str


class NoteCorrection(Payload):
    note_id: Ulid
    text: str


class CheckOut(Payload):
    holder_id: NonEmpty


class _Incoming(Strict):
    """What every event carries. Each subclass pins `type` and the shape of `payload`."""

    id: Ulid
    entity_type: EntityType
    entity_id: NonEmpty
    type: str
    actor_id: NonEmpty
    device_id: NonEmpty
    device_seq: Annotated[int, Field(ge=1)]
    occurred_at: int
    clock_offset: int
    payload: Any

    def payload_dict(self) -> dict[str, Any]:
        return self.payload if isinstance(self.payload, dict) else self.payload.model_dump()


class _ItemOnly(_Incoming):
    @model_validator(mode="after")
    def _items_only(self):
        if self.entity_type != "item":
            raise ValueError(f"{self.type} applies only to items")
        return self


class Created(_Incoming):
    type: Literal["created"]
    payload: dict[str, Any]


class FieldChanged(_Incoming):
    type: Literal["field_changed"]
    payload: FieldChange


class NoteAdded(_Incoming):
    type: Literal["note_added"]
    payload: NoteText


class NoteCorrected(_Incoming):
    type: Literal["note_corrected"]
    payload: NoteCorrection


class CheckedOut(_ItemOnly):
    type: Literal["checked_out"]
    payload: CheckOut


class CheckedIn(_ItemOnly):
    type: Literal["checked_in"]
    payload: dict[str, Any]


IncomingEvent = Annotated[
    Created | FieldChanged | NoteAdded | NoteCorrected | CheckedOut | CheckedIn,
    Field(discriminator="type"),
]
_incoming = TypeAdapter(IncomingEvent)
# Keep in step with the union above. Later milestones add to both; replay must
# grow with them, and the two replays must agree (NFR-MAINT-04).
EVENT_TYPES = frozenset({"created", "field_changed", "note_added", "note_corrected", "checked_out", "checked_in"})


def validate(incoming: Any) -> _Incoming:
    """Refuse what the log cannot hold. Raises Rejected with a reason."""
    try:
        return _incoming.validate_python(incoming)
    except ValidationError as exc:
        raise Rejected.from_validation(exc) from None


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


def append(conn: sqlite3.Connection, incoming: Any, received_at: int | None = None) -> Event:
    """Take one event from a device. Idempotent on id.

    One transaction: the clamp reads the device's last event, the insert
    assigns seq, and the entity's derived state is brought up to date. A retry
    after a dropped connection finds the id already stored and returns that
    row unchanged.
    """
    e = validate(incoming)
    if received_at is None:
        received_at = now_ms()

    conn.execute("BEGIN IMMEDIATE")
    try:
        existing = get(conn, e.id)
        if existing is not None:
            conn.execute("COMMIT")
            return existing

        previous = conn.execute(
            "SELECT device_seq, effective_at FROM events WHERE device_id = ? ORDER BY device_seq DESC LIMIT 1",
            (e.device_id,),
        ).fetchone()
        if previous is not None and e.device_seq <= previous["device_seq"]:
            raise Rejected(f"device_seq {e.device_seq} is not above the last seen, {previous['device_seq']}")

        effective_at = clamp(
            e.occurred_at,
            e.clock_offset,
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
                e.id,
                e.entity_type,
                e.entity_id,
                e.type,
                e.actor_id,
                e.device_id,
                e.device_seq,
                e.occurred_at,
                e.clock_offset,
                effective_at,
                received_at,
                dump_payload(e.payload_dict()),
            ),
        )
        stored = get(conn, e.id)
        assert stored is not None and stored.seq == cursor.lastrowid

        # Imported here, not at the top: derived reads the log, so the modules would be circular.
        from gear_tracker import derived

        derived.refresh_entity(conn, stored.entity_type, stored.entity_id, stored.seq)
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
