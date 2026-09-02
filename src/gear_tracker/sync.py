"""The three sync operations, with no HTTP in them. app.py puts HTTP in front.

See docs/architecture.md, "Sync". Every result carries server_time so the
device can re-measure its clock offset (NFR-DATA-13).
"""

from __future__ import annotations

import sqlite3
from dataclasses import asdict, dataclass
from typing import Any

from pydantic import ValidationError

from gear_tracker import derived, events
from gear_tracker.errors import ApiError, BadRequest, Deactivated, Forbidden, Rebootstrap
from gear_tracker.events import NonEmpty, Rejected, Strict, now_ms
from gear_tracker.flags import add_flag

SyncError = ApiError

RETENTION_MS = 90 * 24 * 3_600_000
"""How far back a device keeps history (NFR-DATA-03). A cursor older than this re-bootstraps instead."""

DRIFT_THRESHOLD_MS = 60_000
"""A stored clock offset this far from a fresh measurement means the device clock moved. Flag, do not trust."""

PAGE_SIZE = 1000


@dataclass(frozen=True)
class Principal:
    """Who is calling. M4 builds one from a credential; until then tests build them directly."""

    user_id: str
    device_id: str
    active: bool = True
    role: str = "user"


class PushBody(Strict):
    device_id: NonEmpty
    client_time: int
    events: list[Any]
    """Each event is judged on its own, so a bad one is a rejection, not a 400."""


def _require_active(principal: Principal) -> None:
    if not principal.active:
        raise Deactivated("this account has been deactivated")


def bootstrap(conn: sqlite3.Connection, principal: Principal, now: int | None = None) -> dict[str, Any]:
    """Current state and the cursor it was true at, read in one transaction (FR-OFF-14)."""
    _require_active(principal)
    now = now_ms() if now is None else now
    conn.execute("BEGIN")
    try:
        snapshot = derived.snapshot(conn)
        cursor = derived.cursor(conn)
    finally:
        conn.execute("COMMIT")
    return {"snapshot": snapshot, "cursor": cursor, "server_time": now}


def push(conn: sqlite3.Connection, principal: Principal, body: Any, now: int | None = None) -> dict[str, Any]:
    """Take a batch of events from one device. Idempotent on event id.

    A deactivated account is still allowed here, and only here (FR-OFF-06).
    Every event is attributed to the signed-in user and device; the server
    does not take the device's word for either.
    """
    now = now_ms() if now is None else now
    try:
        batch = PushBody.model_validate(body)
    except ValidationError as exc:
        raise BadRequest(Rejected.from_validation(exc).reason) from None
    if batch.device_id != principal.device_id:
        raise Forbidden("device_id does not match the credential")

    measured_offset = now - batch.client_time
    accepted: list[str] = []
    rejected: list[dict[str, Any]] = []
    for incoming in batch.events:
        if not isinstance(incoming, dict):
            rejected.append({"id": None, "reason": "event must be a JSON object"})
            continue
        try:
            if incoming.get("actor_id") != principal.user_id:
                raise Rejected("actor_id must be the signed-in user")
            if incoming.get("device_id") != principal.device_id:
                raise Rejected("device_id must be this device")
            _check_entity_rules(conn, principal, incoming)
            seen_before = events.get(conn, incoming["id"]) is not None if isinstance(incoming.get("id"), str) else False
            stored = events.append(conn, incoming, received_at=now)
            if not seen_before:
                _check_drift(conn, stored, measured_offset, now)
            accepted.append(stored.id)
        except Rejected as exc:
            rejected.append({"id": incoming.get("id"), "reason": exc.reason})
    return {"accepted": accepted, "rejected": rejected, "server_time": now}


def _check_entity_rules(conn: sqlite3.Connection, principal: Principal, incoming: dict[str, Any]) -> None:
    """What a device may not do, whatever it says. Field checks happen later, in events.validate."""
    entity_type, kind = incoming.get("entity_type"), incoming.get("type")
    if entity_type == "user":
        raise Rejected("user changes go through the accounts API")
    if entity_type == "setting" and principal.role != "admin":
        raise Rejected("settings are changed by an Admin")
    if entity_type == "item" and kind == "checked_out":
        item = derived.get_entity(conn, "item", str(incoming.get("entity_id")))
        if item is not None and item.get("retired"):
            raise Rejected("retired items cannot be checked out (FR-INV-04)")
        if item is not None and item.get("merged_into"):
            raise Rejected("this item was merged into another (FR-INV-13)")
    if entity_type == "found_report" and kind == "created":
        raise Rejected("found reports come from the public page")
    if kind == "photo_added":
        raise Rejected("photos are uploaded, not pushed")
    if entity_type == "code":
        if kind == "created":
            raise Rejected("codes come from printed sheets")
        if kind == "code_bound":
            code = derived.get_entity(conn, "code", str(incoming.get("entity_id")))
            if code is None:
                raise Rejected("not one of our codes")
            if code.get("item_id") is not None:
                raise Rejected("this code is already on an item")


def _check_drift(conn: sqlite3.Connection, event: events.Event, measured_offset: int, now: int) -> None:
    """The offset the device recorded under should match what we measure now. If not, its clock moved."""
    drift = measured_offset - event.clock_offset
    if abs(drift) > DRIFT_THRESHOLD_MS:
        add_flag(
            conn,
            event.id,
            "clock_drift",
            {"recorded_offset": event.clock_offset, "measured_offset": measured_offset, "drift": drift},
            now,
        )


def pull(conn: sqlite3.Connection, principal: Principal, cursor: int, now: int | None = None) -> dict[str, Any]:
    """Events after a cursor, in seq order. The device calls again until it gets none."""
    _require_active(principal)
    now = now_ms() if now is None else now
    if cursor < 0:
        raise BadRequest("since must be a non-negative integer")

    conn.execute("BEGIN")
    try:
        last = conn.execute("SELECT coalesce(max(seq), 0) FROM events").fetchone()[0]
        if cursor > last:
            raise Rebootstrap("cursor is ahead of the log; the database was probably restored from backup")
        if last > 0:
            if cursor == 0:
                base = conn.execute("SELECT min(received_at) FROM events").fetchone()[0]
            else:
                base = conn.execute(
                    "SELECT received_at FROM events WHERE seq <= ? ORDER BY seq DESC LIMIT 1", (cursor,)
                ).fetchone()[0]
            if base < now - RETENTION_MS:
                raise Rebootstrap("cursor is older than the retention window")
        page = events.since(conn, cursor, PAGE_SIZE)
    finally:
        conn.execute("COMMIT")

    return {
        "events": [asdict(e) for e in page],
        "cursor": page[-1].seq if page else cursor,
        "server_time": now,
    }
