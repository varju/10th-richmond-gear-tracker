"""The three sync operations, with no HTTP in them. app.py puts HTTP in front.

See docs/architecture.md, "Sync". Every result carries server_time so the
device can re-measure its clock offset (NFR-DATA-13).
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import asdict, dataclass
from typing import Annotated, Any

from pydantic import Field, ValidationError

from gear_tracker import derived, events
from gear_tracker.errors import ApiError, BadRequest, Deactivated, Forbidden, Rebootstrap
from gear_tracker.events import NonEmpty, Rejected, Strict, now_ms
from gear_tracker.flags import add_flag

logger = logging.getLogger(__name__)

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
    round_trip_ms: Annotated[int, Field(ge=0)] | None = None
    """The device's last measured round trip (client/src/lib/clock.ts measureOffset halves this to
    get its own offset). Omitted by an older client, or before the device has ever synced."""


def _require_active(principal: Principal) -> None:
    if not principal.active:
        raise Deactivated("this account has been deactivated")


def log_id(conn: sqlite3.Connection) -> str:
    """This log's identity, set when the database was created (migration 0007).

    A device holds the one its snapshot came from. A different one means a
    different log, whatever the cursor says.
    """
    return str(conn.execute("SELECT value FROM meta WHERE key = 'log_id'").fetchone()[0])


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
    return {"snapshot": snapshot, "cursor": cursor, "log_id": log_id(conn), "server_time": now}


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

    # The client's own offset is a round trip halved, so its recorded clock_offset already allows
    # for half the latency of the sync that measured it. A one-way `now - client_time` here has no
    # such allowance and overstates the offset by the full latency of this push; halving the round
    # trip this push took (as last measured) puts the two on the same footing.
    half_trip = batch.round_trip_ms // 2 if batch.round_trip_ms is not None else 0
    measured_offset = now - batch.client_time - half_trip
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
            logger.warning(
                "rejected event %s (%s on %s/%s) from device %s: %s",
                incoming.get("id"),
                incoming.get("type"),
                incoming.get("entity_type"),
                incoming.get("entity_id"),
                principal.device_id,
                exc.reason,
            )
        except Exception:
            # A bad one is a rejection, not a 500 for the whole batch. events.append rolls back
            # its own work on the way out, so the connection is clean for the next event.
            rejected.append({"id": incoming.get("id"), "reason": "the server could not store this event"})
            logger.exception(
                "event %s (%s on %s/%s) from device %s could not be stored",
                incoming.get("id"),
                incoming.get("type"),
                incoming.get("entity_type"),
                incoming.get("entity_id"),
                principal.device_id,
            )
    return {"accepted": accepted, "rejected": rejected, "log_id": log_id(conn), "server_time": now}


def _is_pool(conn: sqlite3.Connection, item_id: Any) -> bool:
    """Whether an id, if it names anything, names a pool (FR-INV-34). A missing or non-item id is not one."""
    if not isinstance(item_id, str):
        return False
    item = derived.get_entity(conn, "item", item_id)
    return bool(item and item.get("pool"))


def _check_entity_rules(conn: sqlite3.Connection, principal: Principal, incoming: dict[str, Any]) -> None:
    """What a device may not do, whatever it says. Field checks happen later, in events.validate."""
    entity_type, kind = incoming.get("entity_type"), incoming.get("type")
    if entity_type == "user":
        raise Rejected("user changes go through the accounts API")
    if entity_type == "setting" and principal.role != "admin":
        raise Rejected("settings are changed by an Admin")
    if entity_type == "location" and principal.role != "admin":
        raise Rejected("locations are an Admin's job (FR-SET-05)")
    if entity_type == "category" and principal.role != "admin" and kind != "created":
        # Anyone signed in may add a category, same as the item editor (see assistant.add_category).
        raise Rejected("categories are renamed and deleted by an Admin (FR-SET-05)")
    if entity_type == "item" and kind == "field_changed":
        payload = incoming.get("payload")
        field = payload.get("field") if isinstance(payload, dict) else None
        # Deleting takes a record off every list for good (FR-INV-32), so it stays with an Admin.
        if field == "deleted" and principal.role != "admin":
            raise Rejected("items are deleted by an Admin")
        # A pool has no units (FR-INV-34): moving one under a pool is refused, whether at creation or later.
        if field == "parent_id" and _is_pool(conn, payload.get("value")):
            raise Rejected("a pool has no units (FR-INV-34)")
        if field == "merged_into" and principal.role != "admin":
            raise Rejected("items are merged by an Admin (FR-INV-13)")
    if entity_type == "item" and kind == "created":
        payload = incoming.get("payload")
        if isinstance(payload, dict):
            if payload.get("pool") and not payload.get("generic"):
                raise Rejected("a pool must be generic (FR-INV-34)")
            if _is_pool(conn, payload.get("parent_id")):
                raise Rejected("a pool has no units (FR-INV-34)")
    if entity_type == "item" and kind in ("checked_out", "checked_in"):
        item = derived.get_entity(conn, "item", str(incoming.get("entity_id"))) or {}
        if item.get("deleted"):
            raise Rejected("this item was deleted")
        is_pool = bool(item.get("pool"))
        if item.get("generic") and not is_pool:
            raise Rejected("a generic item does not move; its units do (FR-INV-21)")
        payload = incoming.get("payload")
        has_count = isinstance(payload, dict) and payload.get("count") is not None
        if is_pool and not has_count:
            raise Rejected("a pool moves by count")
        if not is_pool and has_count:
            raise Rejected("count is only for a pool (FR-OUT-22)")
        if kind == "checked_out":
            if item.get("retired"):
                raise Rejected("retired items cannot be checked out (FR-INV-04)")
            if item.get("merged_into"):
                raise Rejected("this item was merged into another (FR-INV-13)")
    if entity_type == "item" and kind == "recounted":
        item = derived.get_entity(conn, "item", str(incoming.get("entity_id"))) or {}
        if not item.get("pool"):
            raise Rejected("recount is only for a pool (FR-INV-35)")
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
            payload = incoming.get("payload")
            named = payload.get("item_id") if isinstance(payload, dict) else None
            target = derived.get_entity(conn, "item", str(named)) or {}
            if target.get("pool"):
                raise Rejected("a pool has no code (FR-INV-34)")
            if target.get("generic"):
                raise Rejected("a generic item takes no code; put it on a unit (FR-INV-21)")
        if kind == "code_released":
            code = derived.get_entity(conn, "code", str(incoming.get("entity_id")))
            if code is None:
                raise Rejected("not one of our codes")
            if code.get("item_id") is None:
                raise Rejected("this code is not on anything")


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


def pull(
    conn: sqlite3.Connection,
    principal: Principal,
    cursor: int,
    now: int | None = None,
    log: str | None = None,
) -> dict[str, Any]:
    """Events after a cursor, in seq order. The device calls again until it gets none.

    `log` is the log the device's snapshot came from, when it knows one.
    """
    _require_active(principal)
    now = now_ms() if now is None else now
    if cursor < 0:
        raise BadRequest("since must be a non-negative integer")
    if log is not None and log != log_id(conn):
        raise Rebootstrap("this is a different database; start again from a snapshot")

    conn.execute("BEGIN")
    try:
        last = conn.execute("SELECT coalesce(max(seq), 0) FROM events").fetchone()[0]
        if cursor > last:
            raise Rebootstrap("cursor is ahead of the log; the database was probably restored from backup")
        if cursor < last:
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
        "log_id": log_id(conn),
        "server_time": now,
    }
