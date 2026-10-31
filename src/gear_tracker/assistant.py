"""Assistant access over MCP: the same inventory, asked for in words (FR-MCP-01 to FR-MCP-30).

One process. The MCP server is mounted at `/mcp` in the same FastAPI app, over
Streamable HTTP, using the official SDK.

**A token is a device.** "Connect an assistant" in Settings opens a session
whose `device_id` is `mcp-<ulid>`. It authenticates through the same
`accounts.authenticate` as every other route, it is in the device list, and it
is revoked like a lost device (FR-USR-14).

**A write is a push.** A tool builds events with that device_id and a
`device_seq` the server keeps per assistant, then hands them to `sync.push`. So
the entity rules, validation, attribution and drift checks all apply, and
history reads "this Scouter, via the assistant". There is no second write path.

**A read is derived state**, through views.py, which is the Python twin of what
appears on screen.

**A number or yes/no is not a string.** Every count, quantity, day count, port, and flag is
strict, so a JSON `"3"` or `true` sent for one is refused rather than quietly converted, the same as
the event layer refuses it.

**A pool moves by count.** Some gear is a counted stack rather than named units, like tent pegs
(FR-INV-34). `check_out`, `check_in` and `recount` move it by `count`, not by item id alone; the
server refuses a count on anything else and refuses a pool without one. `get_item` on a pool
reports owned, in, and out by holder in place of units and a code (FR-INV-36, FR-MCP-08).

**An Admin's token unlocks an Admin's work** (FR-MCP-10): users, standing join links, mail, group
settings, calendar feeds, locations, categories (adding one is anyone's job), printed codes,
CSV export and import, deleting an item, and merging or unmerging duplicates. Every one of those tools calls
the same accounts.py, mail.py, codes.py or inventory_csv.py function the app's
own endpoint calls, so a User's token is refused the same way the app refuses
a User: `accounts._require_admin` where the app checks it that way, and the
same server- or client-side rule mirrored in the tool where the app only
checks it in the browser (locations, categories, merge, unmerge, delete).
Unassigning a code (FR-MCP-09) is a User's job on any token, so
`unassign_code` sits with the rest of the User tools below.

**What the app does, the assistant does** (FR-MCP-11 to FR-MCP-30), except delete the
signed-in person's own account (FR-MCP-31).
"""

from __future__ import annotations

import base64
import datetime
import functools
import json
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.mcpserver.utilities.types import Image
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StringConstraints
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from gear_tracker import (
    accounts,
    calendars,
    codes,
    derived,
    events,
    inventory_csv,
    labels,
    mail,
    notify,
    sync,
    views,
)
from gear_tracker import conflicts as clashes
from gear_tracker import photos as photo_files
from gear_tracker.db import connect
from gear_tracker.errors import ApiError, BadRequest, Conflict, NotFound, TooLarge
from gear_tracker.events import REPAIR_STATES, HttpsUrlOrBlank, PhotoEntity, PhotoType, now_ms
from gear_tracker.ratelimit import RateLimit
from gear_tracker.sync import Principal
from gear_tracker.ulid import is_ulid, new_ulid

MCP_PATH = "/mcp"

CALLS_PER_MINUTE = (120, 60_000)
"""Generous: an assistant asks several questions to answer one. Per token, in this process."""

HISTORY_SHOWN = 10
"""How many of an item's movements a tool returns. The whole log is in the app."""

INSTRUCTIONS = """Gear Tracker holds a Scout group's gear: what we own, where it lives, who has it,
and what needs fixing. Search before you write, and use the ids the read tools
return. Everything you write is recorded as the signed-in person, through the
assistant. Users, standing join links, mail, group settings, calendar feeds, locations, renaming or deleting
categories, printed codes, CSV import, deleting an item, and merging duplicates
are an Admin's job in the app, and are here too when the signed-in person is an Admin; a User's token is
refused the same way the app refuses a User. A pool is gear kept as a counted stack, not named
units; check_out, check_in and recount move it by count. Everything else a person does in the app
is here too, except deleting their own account."""


@dataclass(frozen=True)
class Caller:
    """Who is on the other end of this tool call, and where their data is."""

    who: Principal
    db_path: Path
    photo_dir: Path


_CALLER: ContextVar[Caller] = ContextVar("gear_tracker_mcp_caller")
"""Set by the guard in front of /mcp, read by every tool. The SDK copies the context into the tool."""


@contextmanager
def acting_as(who: Principal, db_path: str | Path, photo_dir: str | Path | None = None) -> Iterator[None]:
    """Run the tool functions as this caller, outside an MCP request. The endpoint sets the same variable."""
    token = _CALLER.set(Caller(who=who, db_path=Path(db_path), photo_dir=photo_files.store_dir(db_path, photo_dir)))
    try:
        yield
    finally:
        _CALLER.reset(token)


@contextmanager
def _open() -> Iterator[tuple[sqlite3.Connection, Principal]]:
    """A connection and the caller, for the length of one tool call."""
    caller = _CALLER.get()
    conn = connect(caller.db_path)
    try:
        yield conn, caller.who
    finally:
        conn.close()


def _state(conn: sqlite3.Connection) -> dict[str, Any]:
    return derived.snapshot(conn)


# --- writing --------------------------------------------------------------------------------


def _next_seq(conn: sqlite3.Connection, device_id: str, count: int) -> int:
    """Reserve `count` device_seq numbers and return the last of them.

    One statement does the reserving, so two calls cannot take the same number.
    A number burned by a later failure is a gap, and gaps are allowed. The row
    starts from the log, so a counter that was never written still lands above
    anything the device already sent.
    """
    key = f"device_seq:{device_id}"
    if conn.execute("SELECT 1 FROM meta WHERE key = ?", (key,)).fetchone() is None:
        seen = conn.execute(
            "SELECT coalesce(max(device_seq), 0) FROM events WHERE device_id = ?", (device_id,)
        ).fetchone()[0]
        conn.execute("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", (key, str(seen)))
    return conn.execute(
        "UPDATE meta SET value = CAST(value AS INTEGER) + ? WHERE key = ? RETURNING CAST(value AS INTEGER)",
        (count, key),
    ).fetchone()[0]


def _draft(entity_type: str, entity_id: str, type: str, payload: dict[str, Any], event_id: str | None = None) -> dict:
    return {
        "id": event_id or new_ulid(),
        "entity_type": entity_type,
        "entity_id": entity_id,
        "type": type,
        "payload": payload,
    }


def _push(conn: sqlite3.Connection, who: Principal, drafts: list[dict[str, Any]]) -> None:
    """Events from a tool, through the push a device uses (FR-MCP-05). A refusal is the tool's error."""
    if not drafts:
        return
    now = now_ms()
    last = _next_seq(conn, who.device_id, len(drafts))
    first = last - len(drafts) + 1
    batch = [
        {
            **draft,
            "actor_id": who.user_id,
            "device_id": who.device_id,
            "device_seq": first + offset,
            "occurred_at": now,
            "clock_offset": 0,
        }
        for offset, draft in enumerate(drafts)
    ]
    result = sync.push(conn, who, {"device_id": who.device_id, "client_time": now, "events": batch}, now)
    if result["rejected"]:
        raise BadRequest(result["rejected"][0]["reason"])


def _changes(before: dict[str, Any], patch: dict[str, Any]) -> list[tuple[str, Any, Any]]:
    """One field_changed per field that actually differs, old value kept (FR-USR-05)."""
    out = []
    for field, value in patch.items():
        old = before.get(field)
        if (value if value is not None else None) == (old if old is not None else None):
            continue
        out.append((field, value, old if old is not None else None))
    return out


# --- looking things up ------------------------------------------------------------------------


def _item(state: dict[str, Any], item_id: str) -> dict[str, Any]:
    it = views.item(state, views.resolve_item(state, item_id))
    # A deleted record is off every list and every screen, so it is not here either (FR-INV-32).
    if it is None or it.get("deleted"):
        raise NotFound(f"no item with id {item_id}")
    return it


def _live_raw_item(state: dict[str, Any], item_id: str) -> dict[str, Any]:
    """The record itself, as _raw_item, but never one deleted for good (FR-INV-32)."""
    it = _raw_item(state, item_id)
    if it.get("deleted"):
        raise NotFound(f"no item with id {item_id}")
    return it


def _raw_item(state: dict[str, Any], item_id: str) -> dict[str, Any]:
    """The record itself, not the survivor a merge points to (FR-INV-13). What deleteItem, mergeItem and
    unmergeItem read on the device: they act on the id given, not on what it resolves to."""
    it = views.item(state, item_id)
    if it is None:
        raise NotFound("no such item")
    return it


def _reservation(state: dict[str, Any], reservation_id: str) -> dict[str, Any]:
    r = views.reservation(state, reservation_id)
    if r is None:
        raise NotFound(f"no reservation with id {reservation_id}")
    return r


def _ticket(state: dict[str, Any], ticket_id: str) -> dict[str, Any]:
    ticket = views.entity(state, "repair", ticket_id)
    if ticket is None:
        raise NotFound(f"no repair ticket with id {ticket_id}")
    return ticket


def _clean_draft(draft: dict[str, Any]) -> dict[str, Any]:
    """What createReservation stores: a trimmed event, no repeated items, no empty generic lines."""
    return {
        "event": draft["event"].strip(),
        "starts": draft["starts"],
        "ends": draft["ends"],
        "items": list(dict.fromkeys(draft.get("items") or [])),
        "generics": [dict(line) for line in (draft.get("generics") or []) if line["quantity"] > 0],
    }


def _refused(state: dict[str, Any], draft: dict[str, Any], exclude_id: str | None) -> dict[str, Any] | None:
    """The app refuses to save a clashing reservation and names it (FR-RES-05). So does this (FR-MCP-06)."""
    found = clashes.conflicts(state, draft, exclude_id)
    if not found:
        return None
    return {
        "saved": False,
        "message": clashes.describe(found),
        "clashes": [{"reservation_id": c["id"], "event": c["event"], "detail": c["detail"]} for c in found],
    }


# --- what the tools answer with -----------------------------------------------------------------


def _item_brief(state: dict[str, Any], it: dict[str, Any]) -> dict[str, Any]:
    brief = {
        "item_id": it["id"],
        "name": views.display_name(state, it),
        "home": views.home_label(state, it),
        "status": it.get("status"),
    }
    if it.get("holder_id"):
        brief["holder"] = views.user_name(state, it["holder_id"])
    if (it.get("movement") or {}).get("event"):
        brief["event"] = it["movement"]["event"]
    for flag in ("missing", "retired"):
        if it.get(flag):
            brief[flag] = True
    categories = [views.category_name(state, cid) for cid in views.categories_of(state, it)]
    if categories:
        brief["categories"] = categories
    return brief


def _row(state: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    if row["kind"] == "single":
        return {"kind": "single", **_item_brief(state, row["item"])}
    if row["kind"] == "pool":
        counts = row["counts"]
        out = {
            "kind": "pool",
            "item_id": row["item"]["id"],
            "name": row["name"],
            "owned": counts["owned"],
            "in": counts["in"],
            "out": [
                {"holder_id": o["holder_id"], "holder": views.user_name(state, o["holder_id"]), "count": o["count"]}
                for o in counts["out"]
            ],
        }
    else:
        out = {
            "kind": "generic",
            "item_id": row["item"]["id"],
            "name": row["name"],
            "units": row["counts"]["total"],
            "in": row["counts"]["in"],
            "unit_ids": [u["id"] for u in row["units"]],
        }
    categories = [views.category_name(state, cid) for cid in views.categories_of(state, row["item"])]
    if categories:
        out["categories"] = categories
    return out


def _ticket_brief(state: dict[str, Any], ticket: dict[str, Any]) -> dict[str, Any]:
    return {
        "ticket_id": ticket["id"],
        "item_id": ticket.get("item_id"),
        "item": views.name_of(state, ticket.get("item_id")),
        "description": ticket.get("description"),
        "state": ticket.get("state"),
        "raised": views.iso(ticket.get("added_at")),
        "comments": [
            {"text": note["text"], "by": views.user_name(state, note.get("actor_id")), "at": views.iso(note.get("at"))}
            for note in ticket.get("notes") or []
        ],
    }


def _reservation_brief(state: dict[str, Any], r: dict[str, Any]) -> dict[str, Any]:
    out = {
        "reservation_id": r["id"],
        "event": r.get("event"),
        "starts": r.get("starts"),
        "ends": r.get("ends"),
        "items": len(r.get("items") or []),
        "generics": sum(line["quantity"] for line in r.get("generics") or []),
    }
    # Older data, from before a reservation recorded who made it, has no created_by (FR-RES-18).
    if r.get("created_by"):
        out["created_by"] = views.user_name(state, r["created_by"])
        out["added_at"] = views.iso(r.get("added_at"))
    return out


def _item_reservations(state: dict[str, Any], it: dict[str, Any]) -> list[dict[str, Any]]:
    """Live reservations naming this item today or later (FR-INV-37).

    By its own id, by its own line in `generics` (a generic or a pool,
    FR-RES-13), or, for a unit, by its parent generic's line.
    """
    today = views.today(now_ms())
    generic_id = it.get("parent_id") or it["id"]
    found = []
    for r in views.reservations(state):
        if (r.get("ends") or "") < today:
            continue
        by_name = it["id"] in views.named_items(state, r)
        by_generic = any(line["item_id"] == generic_id for line in r.get("generics") or [])
        if by_name or by_generic:
            found.append(
                {"reservation_id": r["id"], "event": r.get("event"), "starts": r.get("starts"), "ends": r.get("ends")}
            )
    return found


def _history(conn: sqlite3.Connection, state: dict[str, Any], item_id: str) -> list[dict[str, Any]]:
    """The item's last few movements, newest first (FR-INV-09). A merged duplicate's movements come
    too, and, for a pool, its recounts alongside its checked_out/checked_in (FR-INV-36)."""
    ids = views.aliases(state, item_id)
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        f"""
        SELECT * FROM events
        WHERE entity_type = 'item' AND entity_id IN ({marks}) AND type IN ('checked_out', 'checked_in', 'recounted')
        ORDER BY effective_at DESC, device_id DESC, device_seq DESC LIMIT ?
        """,
        (*ids, HISTORY_SHOWN),
    ).fetchall()
    corrected = {}
    for fix in conn.execute(
        f"""
        SELECT payload FROM events WHERE entity_type = 'item' AND entity_id IN ({marks}) AND type = 'event_corrected'
        ORDER BY effective_at, device_id, device_seq
        """,
        ids,
    ):
        fixed = json.loads(fix["payload"])
        corrected[fixed["movement_id"]] = fixed.get("event")
    out = []
    for row in rows:
        payload = json.loads(row["payload"])
        if row["id"] in corrected:
            payload["event"] = corrected[row["id"]]
        entry = {
            "type": row["type"],
            "at": views.iso(row["effective_at"]),
            "by": views.user_name(state, row["actor_id"]),
            "holder": views.user_name(state, payload.get("holder_id")) or None,
            "event": payload.get("event"),
        }
        if "count" in payload:
            entry["count"] = payload["count"]
        if "reason" in payload:
            entry["reason"] = payload["reason"]
        out.append(entry)
    return out


# --- read tools ----------------------------------------------------------------------------------

Status = Annotated[str, StringConstraints(pattern="^(in|out|missing)$")]


def search_items(
    query: str = "",
    location_id: str | None = None,
    status: Status | None = None,
    include_retired: StrictBool = False,
) -> dict[str, Any]:
    """Find gear by name or home (FR-INV-07).

    Every word must appear somewhere in the name or the home. One row per thing
    the group owns several of, with how many are in, and single items as rows of
    their own. `status` is "in", "out", or "missing". `include_retired` shows only
    retired gear, like the app's Show retired (FR-INV-05).
    """
    with _open() as (conn, _who):
        state = _state(conn)
        rows = views.rows(state, query, location_id, status, include_retired)
        return {"rows": [_row(state, row) for row in rows], "count": len(rows)}


def get_item(item_id: str) -> dict[str, Any]:
    """One item in full: where it lives, who has it, its units or its generic, open tickets, recent movements."""
    with _open() as (conn, _who):
        state = _state(conn)
        it = _item(state, item_id)
        out: dict[str, Any] = {
            **_item_brief(state, it),
            "description": it.get("description") or "",
            "generic": bool(it.get("generic")),
            "since": views.iso(it.get("since")),
        }
        if views.is_pool(it):
            # A pool has no units (FR-INV-34); owned, in, and out by holder stand in for them
            # (FR-INV-36). It may still carry a code, on the container (FR-TAG-15).
            out["pool"] = True
            counts = views.pool_counts(it)
            out["owned"] = counts["owned"]
            out["in"] = counts["in"]
            out["out"] = [
                {"holder_id": o["holder_id"], "holder": views.user_name(state, o["holder_id"]), "count": o["count"]}
                for o in counts["out"]
            ]
        else:
            if it.get("generic"):
                out["units"] = [_item_brief(state, unit) for unit in views.units_of(state, it["id"])]
            if it.get("parent_id"):
                out["generic_id"] = it["parent_id"]
                out["number"] = it.get("number")
        code_id = views.current_code(state, it["id"])
        if code_id:
            out["code"] = code_id
        out["open_tickets"] = [_ticket_brief(state, t) for t in views.repairs_for(state, it["id"]) if views.is_open(t)]
        out["reservations"] = _item_reservations(state, it)
        # A pool keeps its history (its check-outs, check-ins, and recounts); an ordinary generic
        # never moves, so it has none.
        out["history"] = [] if it.get("generic") and not views.is_pool(it) else _history(conn, state, it["id"])
        out["notes"] = [
            {
                "note_id": note["id"],
                "text": note["text"],
                "by": views.user_name(state, note.get("actor_id")),
                "at": views.iso(note.get("at")),
            }
            for note in it.get("notes") or []
        ]
        out["photos"] = len(it.get("photos") or [])
        return out


def whats_out() -> dict[str, Any]:
    """What is out and who has it (FR-RPT-01), longest out first, with anything overdue flagged."""
    with _open() as (conn, _who):
        state = _state(conn)
        return views.what_is_out(state, now_ms())


def list_reservations(upcoming_only: StrictBool = True) -> dict[str, Any]:
    """Reservations, first day first. Upcoming means it has not ended yet."""
    with _open() as (conn, _who):
        state = _state(conn)
        today = views.today(now_ms())
        found = [r for r in views.reservations(state) if not upcoming_only or (r.get("ends") or "") >= today]
        return {"today": today, "reservations": [_reservation_brief(state, r) for r in found]}


def get_reservation(reservation_id: str) -> dict[str, Any]:
    """One reservation: its gear list, what is packed, what is still to pack, and any clash with another camp."""
    with _open() as (conn, _who):
        state = _state(conn)
        r = _reservation(state, reservation_id)
        rem = views.remaining(state, r)
        return {
            **_reservation_brief(state, r),
            "cancelled": bool(r.get("cancelled")),
            "to_pack": rem["items"],
            "packed": rem["packed"],
            "generic_lines": rem["generics"],
            "fully_packed": views.is_packed(rem),
            "clashes": clashes.conflicts(state, r, reservation_id),
        }


def list_repairs(open_only: StrictBool = True) -> dict[str, Any]:
    """Repair tickets, newest first. Open means open or in progress (FR-REP-05)."""
    with _open() as (conn, _who):
        state = _state(conn)
        found = views.open_tickets(state) if open_only else views.repairs(state)
        if not open_only:
            found = sorted(found, key=lambda t: (-(t.get("added_at") or 0), t["id"]))
        return {"tickets": [_ticket_brief(state, t) for t in found]}


def list_locations() -> dict[str, Any]:
    """Where gear lives. An Admin edits these in the app; here they are only for searching and for a new item."""
    with _open() as (conn, _who):
        state = _state(conn)
        return {
            "locations": [
                {
                    "location_id": loc["id"],
                    "name": loc["name"],
                    "items": sum(1 for it in views.items(state) if it.get("home_location_id") == loc["id"]),
                    "sub_locations": sorted(
                        {
                            it["sub_location"]
                            for it in views.items(state)
                            if it.get("home_location_id") == loc["id"] and it.get("sub_location")
                        }
                    ),
                }
                for loc in views.locations(state)
            ]
        }


def list_categories() -> dict[str, Any]:
    """How gear is grouped: tents, stoves, tarps. An Admin edits these in the app; here they are for a new item
    or an edit."""
    with _open() as (conn, _who):
        state = _state(conn)
        return {
            "categories": [
                {
                    "category_id": cat["id"],
                    "name": cat["name"],
                    "items": sum(
                        1
                        for it in views.items(state)
                        if not it.get("generic") and cat["id"] in views.categories_of(state, it)
                    ),
                }
                for cat in views.categories(state)
            ]
        }


# --- reservation tools -----------------------------------------------------------------------------

IsoDate = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]
NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class GenericLine(BaseModel):
    """So many of something the group owns several of, in place of named units (FR-RES-13)."""

    model_config = ConfigDict(extra="forbid", strict=True)

    item_id: str
    quantity: Annotated[StrictInt, Field(ge=1)]


def _lines(generics: list[GenericLine] | None) -> list[dict[str, Any]]:
    """The SDK hands over models; a caller inside the server may hand over plain dicts."""
    return [GenericLine.model_validate(line).model_dump() for line in generics or []]


def create_reservation(
    event: str,
    starts: IsoDate,
    ends: IsoDate,
    items: list[str] | None = None,
    generics: list[GenericLine] | None = None,
) -> dict[str, Any]:
    """Book gear for a camp (FR-RES-01).

    `items` names particular gear by id; `generics` asks for a quantity of
    something the group owns several of. A clash with another camp on the same
    days is refused and named, as the app refuses it (FR-RES-05).
    """
    with _open() as (conn, who):
        state = _state(conn)
        draft = _clean_draft(
            {
                "event": event,
                "starts": starts,
                "ends": ends,
                "items": items or [],
                "generics": _lines(generics),
            }
        )
        if draft["ends"] < draft["starts"]:
            raise BadRequest("it ends before it starts")
        refused = _refused(state, draft, None)
        if refused:
            return refused
        reservation_id = new_ulid()
        _push(conn, who, [_draft("reservation", reservation_id, "created", draft)])
        return {"saved": True, "reservation_id": reservation_id, "clashes": []}


def update_reservation(
    reservation_id: str,
    event: str | None = None,
    starts: IsoDate | None = None,
    ends: IsoDate | None = None,
) -> dict[str, Any]:
    """Change a reservation's name or its days. Its gear list is changed one line at a time; see the other tools."""
    with _open() as (conn, who):
        state = _state(conn)
        before = _reservation(state, reservation_id)
        patch = {"event": (event or "").strip() if event is not None else None, "starts": starts, "ends": ends}
        wanted = {**before, **{k: v for k, v in patch.items() if v is not None}}
        if wanted["ends"] < wanted["starts"]:
            raise BadRequest("it ends before it starts")
        refused = _refused(state, wanted, reservation_id)
        if refused:
            return refused
        drafts = [
            _draft("reservation", reservation_id, "field_changed", {"field": field, "value": value, "old": old})
            for field, value, old in _changes(before, {k: v for k, v in patch.items() if v is not None})
        ]
        _push(conn, who, drafts)
        return {"saved": True, "reservation_id": reservation_id, "changed": [d["payload"]["field"] for d in drafts]}


def add_to_reservation(reservation_id: str, item_id: str, quantity: StrictInt | None = None) -> dict[str, Any]:
    """Add gear to a reservation.

    Without `quantity` the item joins by name. With it, `item_id` must be
    something the group owns several of, and the line asks for that many
    (FR-RES-13). One line at a time, so two people adding gear offline both land
    (FR-RES-07).
    """
    with _open() as (conn, who):
        state = _state(conn)
        before = _reservation(state, reservation_id)
        it = _item(state, item_id)
        if quantity is not None and quantity < 0:
            raise BadRequest("a quantity starts at 0")
        if quantity is not None and not it.get("generic"):
            raise BadRequest("a quantity is for an item the group owns several of; name this one instead")
        if quantity is None and it.get("generic"):
            raise BadRequest("say how many of this one you want")

        if quantity is None:
            wanted = {**before, "items": [*(before.get("items") or []), it["id"]]}
            change = _draft("reservation", reservation_id, "item_added", {"item_id": it["id"]})
        else:
            lines = [dict(line) for line in before.get("generics") or [] if line["item_id"] != it["id"]]
            if quantity:
                lines.append({"item_id": it["id"], "quantity": quantity})
            wanted = {**before, "generics": lines}
            change = _draft(
                "reservation", reservation_id, "quantity_changed", {"item_id": it["id"], "quantity": quantity}
            )

        refused = _refused(state, _clean_draft(wanted), reservation_id)
        if refused:
            return refused
        _push(conn, who, [change])
        return {"saved": True, "reservation_id": reservation_id, "clashes": []}


def link_out_to_reservation(reservation_id: str, item_id: str) -> dict[str, Any]:
    """Claim gear that went out before the plan did (FR-RES-17). The movement stands; its event is put
    right by an appended record (FR-OUT-16), and the item joins the gear list by name. Nothing moves."""
    with _open() as (conn, who):
        state = _state(conn)
        r = _reservation(state, reservation_id)
        it = _item(state, item_id)
        movement = it.get("movement") or {}
        if it.get("status") != "out" or not movement:
            raise BadRequest("it is not out")
        drafts = []
        if movement.get("event") != r.get("event") or movement.get("reservation_id") != r["id"]:
            correction = {"movement_id": movement["id"], "event": r.get("event"), "reservation_id": r["id"]}
            drafts.append(_draft("item", it["id"], "event_corrected", correction))
        if it["id"] not in (r.get("items") or []):
            drafts.append(_draft("reservation", r["id"], "item_added", {"item_id": it["id"]}))
        _push(conn, who, drafts)
        return {"reservation_id": r["id"], "item_id": it["id"], "corrected": bool(drafts)}


def remove_from_reservation(reservation_id: str, item_id: str) -> dict[str, Any]:
    """Take gear off a reservation, whether it was named or asked for by quantity."""
    with _open() as (conn, who):
        state = _state(conn)
        before = _reservation(state, reservation_id)
        named = [
            i for i in before.get("items") or [] if views.resolve_item(state, i) == views.resolve_item(state, item_id)
        ]
        lines = [line for line in before.get("generics") or [] if line["item_id"] == item_id]
        if not named and not lines:
            raise NotFound("that is not on this reservation")
        drafts = [_draft("reservation", reservation_id, "item_removed", {"item_id": i}) for i in named]
        if lines:
            drafts.append(
                _draft("reservation", reservation_id, "quantity_changed", {"item_id": item_id, "quantity": 0})
            )
        _push(conn, who, drafts)
        return {"saved": True, "reservation_id": reservation_id}


def cancel_reservation(reservation_id: str) -> dict[str, Any]:
    """Call a camp off. The reservation stays in the log; it stops holding gear."""
    with _open() as (conn, who):
        state = _state(conn)
        before = _reservation(state, reservation_id)
        if before.get("cancelled"):
            return {"saved": True, "reservation_id": reservation_id, "already": True}
        _push(
            conn,
            who,
            [
                _draft(
                    "reservation", reservation_id, "field_changed", {"field": "cancelled", "value": True, "old": None}
                )
            ],
        )
        return {"saved": True, "reservation_id": reservation_id}


def duplicate_reservation(reservation_id: str, event: str, starts: IsoDate, ends: IsoDate) -> dict[str, Any]:
    """Book the same gear again on new days (FR-RES-10). Last year's list, this year's camp."""
    with _open() as (conn, who):
        state = _state(conn)
        source = _reservation(state, reservation_id)
        draft = _clean_draft(
            {
                "event": event,
                "starts": starts,
                "ends": ends,
                "items": list(source.get("items") or []),
                "generics": [dict(line) for line in source.get("generics") or []],
            }
        )
        if draft["ends"] < draft["starts"]:
            raise BadRequest("it ends before it starts")
        refused = _refused(state, draft, None)
        if refused:
            return refused
        new_id = new_ulid()
        _push(conn, who, [_draft("reservation", new_id, "created", draft)])
        return {"saved": True, "reservation_id": new_id, "copied_from": reservation_id, "clashes": []}


# --- item tools -------------------------------------------------------------------------------------


class ItemFields(BaseModel):
    """What an assistant may change on an item. Anything else is the app's job."""

    model_config = ConfigDict(extra="forbid", strict=True)

    name: str | None = None
    description: str | None = None
    home_location_id: str | None = None
    sub_location: str | None = None
    purchase_date: IsoDate | None = None
    nickname: str | None = None
    number: NonBlank | None = None
    category_ids: list[str] | None = None


def _home(state: dict[str, Any], location_id: str | None) -> None:
    if location_id and views.entity(state, "location", location_id) is None:
        raise NotFound(f"no location with id {location_id}; call list_locations")


def _category(state: dict[str, Any], category_id: str | None) -> None:
    if category_id and views.entity(state, "category", category_id) is None:
        raise NotFound(f"no category with id {category_id}; call list_categories")


def _sorted_categories(state: dict[str, Any], category_ids: list[str]) -> list[str]:
    """Unique, ordered by category name, so two devices record the same set the same way."""
    unique = list(dict.fromkeys(category_ids))
    return sorted(unique, key=lambda cid: views.category_name(state, cid))


def create_item(
    name: str,
    home_location_id: str | None = None,
    sub_location: str | None = None,
    description: str | None = None,
    generic: StrictBool = False,
    pool: StrictBool = False,
    quantity: Annotated[StrictInt, Field(ge=0)] | None = None,
    category_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Add gear to the inventory (FR-INV-01).

    `generic` is for something the group owns several of: the name is stored
    once and each one becomes a numbered unit under it (FR-INV-21). Add those
    with add_unit. `pool` is for a counted stack instead, like tent pegs
    (FR-INV-34): give `quantity`, and it moves by count through check_out,
    check_in and recount, with no units of its own though assign_code can still
    put one code on the container (FR-TAG-15); `pool` implies `generic`.
    `category_ids` puts it in any number of groups of similar gear (FR-SET-07);
    call list_categories for the ids.
    """
    with _open() as (conn, who):
        state = _state(conn)
        if not name.strip():
            raise BadRequest("an item needs a name")
        if pool and quantity is None:
            raise BadRequest("a pool needs a quantity")
        if quantity is not None and not pool:
            raise BadRequest("quantity is only for a pool")
        _home(state, home_location_id)
        for category_id in category_ids or []:
            _category(state, category_id)
        payload: dict[str, Any] = {"name": name.strip()}
        if pool:
            payload["generic"] = True
            payload["pool"] = True
            payload["quantity"] = quantity
        elif generic:
            payload["generic"] = True
        if home_location_id:
            payload["home_location_id"] = home_location_id
        if sub_location and sub_location.strip():
            payload["sub_location"] = sub_location.strip()
        if description and description.strip():
            payload["description"] = description.strip()
        if category_ids:
            payload["category_ids"] = _sorted_categories(state, category_ids)
        item_id = new_ulid()
        _push(conn, who, [_draft("item", item_id, "created", payload)])
        return {"item_id": item_id, "name": payload["name"], "generic": bool(payload.get("generic")), "pool": pool}


def _next_number(taken: set[str]) -> str:
    """One after the largest whole number in use, or "1" under an empty generic (FR-INV-23)."""
    used = [int(n) for n in taken if n.isdigit()]
    return str(max(used) + 1 if used else 1)


def add_unit(generic_id: str, number: str | None = None, nickname: str | None = None) -> dict[str, Any]:
    """One more of something the group owns several of (FR-INV-22).

    The number is text, because the gear may be labelled "A" or "3b"
    (FR-INV-23). Left out, it is one after the largest whole number in use. The
    unit takes its generic's home unless you say otherwise.
    """
    with _open() as (conn, who):
        state = _state(conn)
        parent = _item(state, generic_id)
        if not parent.get("generic"):
            raise BadRequest("that item is not one the group owns several of")
        taken = _numbers(state, parent["id"])
        number = _next_number(taken) if number is None else number.strip()
        if not number:
            raise BadRequest("a unit needs a number")
        if number in taken:
            raise Conflict(f"#{number} is taken")
        payload: dict[str, Any] = {"parent_id": parent["id"], "number": number}
        if nickname and nickname.strip():
            payload["nickname"] = nickname.strip()
        if parent.get("home_location_id"):
            payload["home_location_id"] = parent["home_location_id"]
        if parent.get("sub_location"):
            payload["sub_location"] = parent["sub_location"]
        unit_id = new_ulid()
        _push(conn, who, [_draft("item", unit_id, "created", payload)])
        return {"item_id": unit_id, "generic_id": parent["id"], "number": number}


def update_item(item_id: str, fields: ItemFields) -> dict[str, Any]:
    """Change an item's own fields. Only what differs is recorded, with the old value kept (FR-USR-05)."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        patch = fields.model_dump(exclude_unset=True)
        if not patch:
            raise BadRequest("say which fields to change")
        _home(state, patch.get("home_location_id"))
        if "category_ids" in patch:
            if it.get("parent_id"):
                raise BadRequest("a unit takes its generic's categories")
            for category_id in patch["category_ids"] or []:
                _category(state, category_id)
            patch["category_ids"] = _sorted_categories(state, patch["category_ids"] or [])
        if "number" in patch and not it.get("parent_id"):
            raise BadRequest("only one of several has a number")
        if "number" in patch:
            patch["number"] = patch["number"].strip()
            if _number_taken(state, it["parent_id"], patch["number"], it["id"]):
                raise Conflict(f"#{patch['number']} is taken")
        # A list compares by value, not like the fallback `category_id` it may still carry, so
        # the old side of the diff is the resolved set, not the raw field.
        before = {**it, "category_ids": views.categories_of(state, it)} if "category_ids" in patch else it
        drafts = [
            _draft("item", it["id"], "field_changed", {"field": field, "value": value, "old": old})
            for field, value, old in _changes(before, patch)
        ]
        _push(conn, who, drafts)
        return {"item_id": it["id"], "changed": [d["payload"]["field"] for d in drafts]}


def mark_missing(item_id: str) -> dict[str, Any]:
    """Say an item is lost (FR-INV-19). It stays in the inventory and clears on the next scan or check-in."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        if views.is_pool(it):
            raise BadRequest("a pool is stock, use recount")
        if it.get("generic"):
            raise BadRequest("a generic does not go missing; one of its units does")
        if it.get("missing"):
            return {"item_id": it["id"], "missing": True, "already": True}
        _push(conn, who, [_draft("item", it["id"], "field_changed", {"field": "missing", "value": True, "old": None})])
        return {"item_id": it["id"], "missing": True}


def assign_code(code: str, item_id: str) -> dict[str, Any]:
    """Put a printed code on an item (FR-TAG-04). The code must be one we printed and not on anything;
    an item that already has a code gets the new one, and the old one still resolves (FR-TAG-05)."""
    with _open() as (conn, who):
        if not codes.is_code(code):
            raise BadRequest("not a code")
        bound = codes.resolve(conn, code)
        if bound is None:
            raise NotFound("not one of our codes")
        if bound.get("item_id"):
            raise Conflict(f"that code is already on {views.name_of(_state(conn), bound['item_id'])}")
        state = _state(conn)
        it = _item(state, item_id)
        # A pool takes a code on its container (FR-TAG-15); a generic with units still does not (FR-INV-21).
        if it.get("generic") and not views.is_pool(it):
            raise BadRequest("a generic has no code; its units do")
        _push(conn, who, [_draft("code", code, "code_bound", {"item_id": it["id"]})])
        return {"item_id": it["id"], "code": code}


def retire_item(item_id: str, retired: StrictBool = True) -> dict[str, Any]:
    """Write gear off, or bring it back (FR-INV-04). Retired gear stays in history and off every list.
    A generic is retired after its units are."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        if bool(it.get("retired")) == retired:
            return {"item_id": it["id"], "retired": retired, "already": True}
        if retired and it.get("generic") and any(not u.get("retired") for u in views.units_of(state, it["id"])):
            raise BadRequest("retire its units first")
        payload = {"field": "retired", "value": retired, "old": it.get("retired")}
        _push(conn, who, [_draft("item", it["id"], "field_changed", payload)])
        return {"item_id": it["id"], "retired": retired}


def unassign_code(item_id: str) -> dict[str, Any]:
    """Take an item's code off it, on purpose (FR-TAG-14). Only for a sticker already off the gear:
    the code goes back to unassigned, so scanning it again offers a new item or a bind (FR-TAG-07)."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        code_id = views.current_code(state, it["id"])
        if code_id is None:
            raise BadRequest("this item has no code to unassign")
        _push(conn, who, [_draft("code", code_id, "code_released", {})])
        return {"item_id": it["id"], "code": code_id}


def delete_item(item_id: str) -> dict[str, Any]:
    """Take a record made in error off every list, for good (FR-INV-32). Admins only.

    Only an item with nothing out, and a generic only once it has no units. Retire is
    for gear written off; this is for a duplicate that was never real. Its codes go back
    to unassigned (FR-TAG-14), so the stickers can go on the item that is real.
    """
    with _open() as (conn, who):
        accounts._require_admin(who)
        state = _state(conn)
        it = _raw_item(state, item_id)
        if it.get("merged_into"):
            raise BadRequest("this item was merged into another")
        if views.has_gear_out(state, it):
            raise BadRequest("return it first")
        if it.get("generic") and views.units_of(state, item_id):
            raise BadRequest("delete its units first")
        released = views.codes_for(state, item_id)
        drafts = [_draft("code", code_id, "code_released", {}) for code_id in released]
        drafts.append(_draft("item", item_id, "field_changed", {"field": "deleted", "value": True, "old": None}))
        _push(conn, who, drafts)
        return {"item_id": item_id, "deleted": True, "released_codes": released}


def merge_items(duplicate_id: str, survivor_id: str) -> dict[str, Any]:
    """Fold a duplicate record into the item it doubles (FR-INV-13). Admins only.

    The duplicate points at the survivor; nothing is rewritten. The duplicate
    must have nothing out, and neither item retired or already merged.
    """
    with _open() as (conn, who):
        accounts._require_admin(who)
        state = _state(conn)
        dup = _raw_item(state, duplicate_id)
        survivor = _raw_item(state, survivor_id)
        if duplicate_id == survivor_id:
            raise BadRequest("an item cannot be merged into itself")
        if dup.get("merged_into") or survivor.get("merged_into"):
            raise BadRequest("already merged")
        if dup.get("retired") or survivor.get("retired"):
            raise BadRequest("retired items cannot be merged")
        if views.has_gear_out(state, dup):
            raise BadRequest("return it first")
        payload = {"field": "merged_into", "value": survivor_id, "old": None}
        _push(conn, who, [_draft("item", duplicate_id, "field_changed", payload)])
        return {"duplicate_id": duplicate_id, "survivor_id": survivor_id}


def unmerge_item(item_id: str) -> dict[str, Any]:
    """Undo a merge (FR-INV-13). The item stands on its own again. Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        state = _state(conn)
        it = _raw_item(state, item_id)
        if not it.get("merged_into"):
            raise BadRequest("this item is not merged")
        drafts = [
            _draft("item", item_id, "field_changed", {"field": field, "value": value, "old": old})
            for field, value, old in _changes(it, {"merged_into": None})
        ]
        _push(conn, who, drafts)
        return {"item_id": item_id, "merged_into": None}


def _unit_number(value: str) -> str:
    """A number as it is stored: what was typed, trimmed. Blank is not a number (FR-INV-23)."""
    number = value.strip()
    if not number:
        raise BadRequest("a unit needs a number")
    return number


def _numbers(state: dict[str, Any], generic_id: str, except_id: str | None = None) -> set[str]:
    """The unit numbers in use under a generic, as stored: trimmed text."""
    return {str(u.get("number") or "").strip() for u in views.units_of(state, generic_id) if u["id"] != except_id}


def _number_taken(state: dict[str, Any], generic_id: str, number: str, except_id: str | None = None) -> bool:
    return number in _numbers(state, generic_id, except_id)


def _clean(fields: dict[str, Any]) -> dict[str, Any]:
    """What the app stores: strings trimmed, a blank one is absence. None stays, to clear a field."""
    return {k: (v.strip() or None) if isinstance(v, str) else v for k, v in fields.items()}


def _field_drafts(it: dict[str, Any], patch: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        _draft("item", it["id"], "field_changed", {"field": field, "value": value, "old": old})
        for field, value, old in _changes(it, patch)
    ]


def _created_payload(fields: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in _clean(fields).items() if v is not None and v != []}


def _carried(state: dict[str, Any], it: dict[str, Any], *, purchase: bool = True) -> dict[str, Any]:
    """What a new item made from this one takes: name, description, home and categories, and, unless the
    app leaves it on the unit (makeGeneric does), the purchase date."""
    fields: dict[str, Any] = {
        "name": it.get("name") or "",
        "description": it.get("description") or "",
        "home_location_id": it.get("home_location_id"),
        "sub_location": it.get("sub_location") or "",
        "category_ids": _sorted_categories(state, views.categories_of(state, it)),
    }
    if purchase:
        fields["purchase_date"] = it.get("purchase_date")
    return _created_payload(fields)


def _make_generic_drafts(state: dict[str, Any], it: dict[str, Any], number: str) -> tuple[str, list[dict[str, Any]]]:
    """makeGeneric in actions.ts: a new generic takes the item's name, description, home and categories,
    and the item becomes its unit with this number (FR-INV-26)."""
    generic_id = new_ulid()
    payload = _carried(state, it, purchase=False)
    drafts = [_draft("item", generic_id, "created", {**payload, "generic": True})]
    drafts += _field_drafts(it, {"parent_id": generic_id, "number": number, "name": None})
    return generic_id, drafts


def make_generic(item_id: str, number: str = "1") -> dict[str, Any]:
    """Say the group owns several of a single item (FR-INV-26). A new generic takes its name, description,
    home and categories; the item becomes its first unit, with this number, and keeps its code and history."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        if it.get("generic"):
            raise BadRequest("already generic")
        if it.get("parent_id"):
            raise BadRequest("this is already one of several")
        first = _unit_number(number)
        generic_id, drafts = _make_generic_drafts(state, it, first)
        _push(conn, who, drafts)
        return {"generic_id": generic_id, "item_id": it["id"], "number": first}


def group_items(item_id: str, other_id: str, number: str, other_number: str = "1") -> dict[str, Any]:
    """Two items that are really the same kind of thing become units of one generic (FR-INV-30).

    Not a merge: both are real. If the other is a single item, a generic is made from its name and it
    becomes unit `other_number`; if it is a generic or one of its units, this item joins that generic.
    This item becomes unit `number`. Both keep their own home, code, movements and tickets.
    """
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        other = _item(state, other_id)
        if it["id"] == other["id"]:
            raise BadRequest("an item cannot be grouped with itself")
        if it.get("generic"):
            raise BadRequest("this is already a name for several")
        if it.get("parent_id"):
            raise BadRequest("this is already one of several")
        if views.is_pool(other):
            raise BadRequest("a pool has no units (FR-INV-34)")
        mine = _unit_number(number)
        theirs = _unit_number(other_number)
        fresh = not other.get("generic") and not other.get("parent_id")
        if fresh:
            if mine == theirs:
                raise BadRequest("the two need different numbers")
            generic_id, drafts = _make_generic_drafts(state, other, theirs)
        else:
            generic_id, drafts = other.get("parent_id") or other["id"], []
            if _number_taken(state, generic_id, mine):
                raise Conflict(f"#{mine} is taken")
        drafts += _field_drafts(it, {"parent_id": generic_id, "number": mine, "name": None})
        _push(conn, who, drafts)
        return {"generic_id": generic_id, "item_id": it["id"], "number": mine}


def move_unit(unit_id: str, generic_id: str) -> dict[str, Any]:
    """A unit filed under the wrong generic moves to another (FR-INV-28). Its history moves with it;
    a number already taken there is bumped to the next free one."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, unit_id)
        parent = _item(state, generic_id)
        if not it.get("parent_id"):
            raise BadRequest("not a unit")
        if not parent.get("generic"):
            raise BadRequest("not a generic item")
        if views.is_pool(parent):
            raise BadRequest("a pool has no units (FR-INV-34)")
        if parent["id"] == it["parent_id"]:
            return {"item_id": it["id"], "generic_id": parent["id"], "number": it.get("number"), "already": True}
        mine = str(it.get("number") or "").strip()
        number = _next_number(_numbers(state, parent["id"])) if _number_taken(state, parent["id"], mine) else mine
        _push(conn, who, _field_drafts(it, {"parent_id": parent["id"], "number": number}))
        return {"item_id": it["id"], "generic_id": parent["id"], "number": number}


def make_single(generic_id: str) -> dict[str, Any]:
    """A generic becomes a single item again (FR-INV-33, FR-INV-39). Only with one unit left, or none.

    With one, that unit becomes the item: it takes the generic's name, description, categories and
    purchase details, and keeps its own home if it has one. It must be in. With none, a new item takes
    them. Either way the generic folds into the result, and its page still points there.
    """
    with _open() as (conn, who):
        state = _state(conn)
        generic = _live_raw_item(state, generic_id)
        if not generic.get("generic") or views.is_pool(generic):
            raise BadRequest("not a generic item")
        if generic.get("merged_into"):
            raise BadRequest("already merged")
        units = views.units_of(state, generic["id"])
        if len(units) > 1:
            raise BadRequest("needs no more than one unit")
        categories = _sorted_categories(state, views.categories_of(state, generic))
        if not units:
            item_id = new_ulid()
            drafts = [_draft("item", item_id, "created", _carried(state, generic))]
        else:
            unit = units[0]
            if unit.get("status") != "in":
                raise BadRequest("return it first")
            item_id = unit["id"]
            nickname = (unit.get("nickname") or "").strip()
            description = generic.get("description") or ""
            if nickname:
                description = " · ".join(part for part in (description, nickname) if part)
            own_home = bool(unit.get("home_location_id"))
            patch = _clean(
                {
                    "parent_id": None,
                    "number": None,
                    "nickname": None,
                    "name": generic.get("name") or "",
                    "description": description,
                    "category_ids": categories,
                    "home_location_id": unit.get("home_location_id") or generic.get("home_location_id"),
                    "sub_location": (unit.get("sub_location") if own_home else generic.get("sub_location")) or "",
                    "purchase_date": unit.get("purchase_date") or generic.get("purchase_date"),
                }
            )
            # The old side is the resolved set, as update_item reads it, not the raw field.
            drafts = _field_drafts({**unit, "category_ids": views.categories_of(state, unit)}, patch)
        drafts += _field_drafts(generic, {"merged_into": item_id})
        _push(conn, who, drafts)
        return {"item_id": item_id, "generic_id": generic["id"]}


def make_pool(item_id: str, quantity: Annotated[StrictInt, Field(ge=1)]) -> dict[str, Any]:
    """A single item, or a generic with no units, becomes a counted stack of `quantity` (FR-INV-34,
    FR-INV-40). A new pool takes its name, description, home, categories and purchase details, and the
    item folds into it; a single item's code then opens the pool. A single item must be in."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _live_raw_item(state, item_id)
        if it.get("parent_id"):
            raise BadRequest("this is already one of several")
        if it.get("merged_into"):
            raise BadRequest("already merged")
        if it.get("generic"):
            if views.is_pool(it):
                raise BadRequest("already several")
            if views.units_of(state, it["id"]):
                raise BadRequest("remove its units first")
        elif it.get("status") != "in":
            raise BadRequest("return it first")
        pool_id = new_ulid()
        payload = _carried(state, it)
        drafts = [_draft("item", pool_id, "created", {**payload, "generic": True, "pool": True, "quantity": quantity})]
        drafts += _field_drafts(it, {"merged_into": pool_id})
        _push(conn, who, drafts)
        return {"item_id": pool_id, "from_id": it["id"], "quantity": quantity}


# --- notes and photos -------------------------------------------------------------------------------


def _note(it: dict[str, Any], note_id: str) -> None:
    if not any(n["id"] == note_id for n in it.get("notes") or []):
        raise NotFound(f"no note with id {note_id}; get_item lists them")


def add_note(item_id: str, text: str) -> dict[str, Any]:
    """A note on an item, without moving it (FR-OUT-13). To note a move, pass `note` to check_out or check_in."""
    with _open() as (conn, who):
        it = _item(_state(conn), item_id)
        if not text.strip():
            raise BadRequest("a note needs some text")
        draft = _draft("item", it["id"], "note_added", {"text": text.strip()})
        _push(conn, who, [draft])
        return {"item_id": it["id"], "note_id": draft["id"]}


def correct_note(item_id: str, note_id: str, text: str) -> dict[str, Any]:
    """Change a note's text (FR-OUT-16). The original stays in the log."""
    with _open() as (conn, who):
        it = _item(_state(conn), item_id)
        _note(it, note_id)
        if not text.strip():
            raise BadRequest("a note needs some text; use delete_note to remove it")
        _push(conn, who, [_draft("item", it["id"], "note_corrected", {"note_id": note_id, "text": text.strip()})])
        return {"item_id": it["id"], "note_id": note_id}


def delete_note(item_id: str, note_id: str) -> dict[str, Any]:
    """Stop showing a note (FR-OUT-21). Who wrote it, and when, stays in the log."""
    with _open() as (conn, who):
        it = _item(_state(conn), item_id)
        _note(it, note_id)
        _push(conn, who, [_draft("item", it["id"], "note_deleted", {"note_id": note_id})])
        return {"item_id": it["id"], "note_id": note_id, "deleted": True}


def _photos_of(state: dict[str, Any], entity_type: str, entity_id: str) -> tuple[str, list[dict[str, Any]]]:
    if entity_type == "item":
        it = _item(state, entity_id)
        return it["id"], it.get("photos") or []
    ticket = _ticket(state, entity_id)
    return ticket["id"], ticket.get("photos") or []


def list_photos(entity_type: PhotoEntity, entity_id: str) -> dict[str, Any]:
    """The photos on an item or a repair ticket (FR-INV-11, FR-REP-01). get_photo returns one."""
    with _open() as (conn, _who):
        state = _state(conn)
        _, photos = _photos_of(state, entity_type, entity_id)
        return {
            "photos": [
                {
                    "photo_id": ph["id"],
                    "content_type": ph["content_type"],
                    "size": ph["size"],
                    "by": views.user_name(state, ph.get("actor_id")),
                    "at": views.iso(ph.get("at")),
                }
                for ph in photos
            ]
        }


def get_photo(photo_id: str) -> Image:
    """One photo, as an image."""
    with _open() as (_conn, _who):
        if not is_ulid(photo_id):
            raise BadRequest("photo_id must be a ULID")
        path = photo_files.path_of(_CALLER.get().photo_dir, photo_id)
        if path is None:
            raise NotFound("no such photo")
        return Image(data=path.read_bytes(), format=photo_files.content_type_of(path).removeprefix("image/"))


def add_photo(entity_type: PhotoEntity, entity_id: str, content_type: PhotoType, data_base64: str) -> dict[str, Any]:
    """Attach a photo to an item or a repair ticket (FR-INV-11, FR-REP-01): the image bytes, base64-encoded,
    at most 5 MB once decoded."""
    with _open() as (conn, who):
        target, _photos = _photos_of(_state(conn), entity_type, entity_id)
        # Base64 is four characters for three bytes; checked before decoding, so a huge string is refused cheaply.
        if len(data_base64) > photo_files.MAX_BYTES * 3 // 2:
            raise TooLarge(photo_files.TOO_LARGE)
        try:
            data = base64.b64decode("".join(data_base64.split()), validate=True)
        except ValueError as e:
            raise BadRequest("data_base64 is not valid base64") from e
        photo_id = new_ulid()
        photo_files.save(conn, _CALLER.get().photo_dir, who.user_id, photo_id, entity_type, target, content_type, data)
        return {"photo_id": photo_id, "size": len(data)}


def remove_photo(entity_type: PhotoEntity, entity_id: str, photo_id: str) -> dict[str, Any]:
    """Stop showing a photo. The file stays on the server, and the log says who removed it."""
    with _open() as (conn, who):
        target, photos = _photos_of(_state(conn), entity_type, entity_id)
        if not any(ph["id"] == photo_id for ph in photos):
            raise NotFound("no such photo on it")
        _push(conn, who, [_draft(entity_type, target, "photo_removed", {"photo_id": photo_id})])
        return {"photo_id": photo_id, "removed": True}


# --- repair tools -----------------------------------------------------------------------------------

RepairState = Annotated[str, StringConstraints(pattern="^(" + "|".join(REPAIR_STATES) + ")$")]


def raise_ticket(item_id: str, description: str) -> dict[str, Any]:
    """Report something wrong with an item (FR-REP-01). The ticket opens open, and the item is flagged."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        if not description.strip():
            raise BadRequest("say what is wrong")
        ticket_id = new_ulid()
        _push(
            conn,
            who,
            [_draft("repair", ticket_id, "created", {"item_id": it["id"], "description": description.strip()})],
        )
        return {"ticket_id": ticket_id, "item_id": it["id"], "state": "open"}


def comment_ticket(ticket_id: str, text: str) -> dict[str, Any]:
    """Add a comment to a repair ticket (FR-REP-06)."""
    with _open() as (conn, who):
        state = _state(conn)
        ticket = _ticket(state, ticket_id)
        if not text.strip():
            raise BadRequest("say something")
        _push(conn, who, [_draft("repair", ticket["id"], "note_added", {"text": text.strip()})])
        return {"ticket_id": ticket["id"]}


def set_ticket_state(ticket_id: str, state: RepairState) -> dict[str, Any]:
    """Move a ticket along (FR-REP-03): open, in_progress, resolved, or wont_fix."""
    with _open() as (conn, who):
        snapshot = _state(conn)
        ticket = _ticket(snapshot, ticket_id)
        if ticket.get("state") == state:
            return {"ticket_id": ticket["id"], "state": state, "already": True}
        _push(
            conn,
            who,
            [
                _draft(
                    "repair",
                    ticket["id"],
                    "field_changed",
                    {"field": "state", "value": state, "old": ticket.get("state")},
                )
            ],
        )
        return {"ticket_id": ticket["id"], "state": state}


# --- movement tools ---------------------------------------------------------------------------------


Count = Annotated[StrictInt, Field(ge=1)]


def list_found_reports() -> dict[str, Any]:
    """What strangers have said about our gear and nobody has dealt with yet (FR-PUB-03), newest first."""
    with _open() as (conn, _who):
        state = _state(conn)
        reports = [
            {"report_id": rid, **fields}
            for rid, fields in (state.get("found_report") or {}).items()
            if not fields.get("resolved")
        ]
        reports.sort(key=lambda r: (-(r.get("added_at") or 0), r["report_id"]))
        return {
            "reports": [
                {
                    "report_id": r["report_id"],
                    "code": r.get("code"),
                    "item_id": r.get("item_id"),
                    "item": views.name_of(state, r.get("item_id")) if r.get("item_id") else None,
                    "note": r.get("note", ""),
                    "contact": r.get("contact", ""),
                    "at": views.iso(r.get("added_at")),
                }
                for r in reports
            ]
        }


def resolve_found_report(report_id: str) -> dict[str, Any]:
    """Dealt with (FR-PUB-03). The finder's words are not edited; the report just stops being listed."""
    with _open() as (conn, who):
        state = _state(conn)
        report = views.entity(state, "found_report", report_id)
        if report is None:
            raise NotFound(f"no found report with id {report_id}")
        if report.get("resolved"):
            return {"report_id": report_id, "resolved": True, "already": True}
        payload = {"field": "resolved", "value": True, "old": report.get("resolved")}
        _push(conn, who, [_draft("found_report", report_id, "field_changed", payload)])
        return {"report_id": report_id, "resolved": True}


def get_notifications() -> dict[str, Any]:
    """What the signed-in person is emailed about (FR-USR-18), and whether the server can send mail at all."""
    with _open() as (conn, who):
        return {"categories": notify.get(conn, who.user_id), "mail_configured": mail.configured(conn)}


def set_notifications(categories: notify.Preferences) -> dict[str, Any]:
    """Choose what the signed-in person is emailed about (FR-USR-18): found reports, new repair tickets,
    new accounts. Nothing is sent until an Admin sets mail up."""
    with _open() as (conn, who):
        saved = notify.set_categories(conn, who.user_id, categories)
        return {"categories": saved, "mail_configured": mail.configured(conn)}


def check_out(
    item_id: str,
    event: str | None = None,
    note: str | None = None,
    count: Count | None = None,
    reservation_id: str | None = None,
) -> dict[str, Any]:
    """Take an item out, without a scan (FR-OUT-02). The holder is you; `event` is what it is going to.

    A pool (FR-INV-34) needs `count`; anything else refuses one (FR-MCP-08). Taking more than are
    in a pool warns, and is never blocked (FR-OUT-22). `reservation_id` says this packs that
    reservation (FR-RES-02); without it the check-out counts towards no reservation's progress.
    """
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        if reservation_id is not None:
            _reservation(state, reservation_id)
        pool = views.is_pool(it)
        if it.get("generic") and not pool:
            raise BadRequest("that item does not move; one of its units does")
        if pool and count is None:
            raise BadRequest("a pool moves by count; say how many")
        if not pool and count is not None:
            raise BadRequest("count is only for a pool (FR-OUT-22)")
        if it.get("retired"):
            raise BadRequest("retired items cannot be checked out")
        if not pool and it.get("status") == "out":
            raise Conflict(f"already out with {views.user_name(state, it.get('holder_id'))}")
        movement_id = new_ulid()
        payload: dict[str, Any] = {
            "holder_id": who.user_id,
            "event": (event or "").strip() or None,
            "reservation_id": reservation_id,
        }
        if pool:
            payload["count"] = count
        drafts = [_draft("item", it["id"], "checked_out", payload, movement_id)]
        if note and note.strip():
            drafts.append(_draft("item", it["id"], "note_added", {"text": note.strip(), "movement_id": movement_id}))
        _push(conn, who, drafts)
        out: dict[str, Any] = {"item_id": it["id"], "event": (event or "").strip() or None}
        if pool:
            out["count"] = count
            still_in = views.pool_counts(it)["in"]
            if count > still_in:
                out["warning"] = f"only {still_in} were in"
        else:
            out["status"] = "out"
        return out


def check_in(
    item_id: str, note: str | None = None, count: Count | None = None, holder_id: str | None = None
) -> dict[str, Any]:
    """Bring an item back, without a scan (FR-OUT-07). Anyone can check anything in (FR-OUT-08).

    A pool (FR-INV-34) comes back from one holder: you, unless `holder_id` names someone else who has
    some out (get_item lists them). `count` defaults to all that holder has out; say fewer to leave
    the rest against their name (FR-OUT-23).
    """
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        pool = views.is_pool(it)
        if it.get("generic") and not pool:
            raise BadRequest("that item does not move; one of its units does")
        holder = holder_id or who.user_id
        if pool:
            have = next((o["count"] for o in views.pool_counts(it)["out"] if o["holder_id"] == holder), 0)
            whose = "you have" if holder == who.user_id else f"{views.user_name(state, holder)} has"
            if count is None:
                if not have:
                    raise BadRequest(f"{whose} none of this out")
                count = have
            elif count > have:
                raise BadRequest(f"{whose} only {have} out")
        else:
            if count is not None:
                raise BadRequest("count is only for a pool (FR-OUT-22)")
            if holder_id is not None:
                raise BadRequest("holder_id is only for a pool; anyone can check anything else in")
            if it.get("status") != "out":
                raise Conflict("it is already in")
        movement_id = new_ulid()
        payload: dict[str, Any] = {}
        if pool:
            payload["count"] = count
            if holder != who.user_id:
                payload["holder_id"] = holder
        drafts = [_draft("item", it["id"], "checked_in", payload, movement_id)]
        if note and note.strip():
            drafts.append(_draft("item", it["id"], "note_added", {"text": note.strip(), "movement_id": movement_id}))
        if not pool and it.get("missing"):
            # It turned up (FR-INV-19).
            drafts.append(_draft("item", it["id"], "field_changed", {"field": "missing", "value": False, "old": True}))
        _push(conn, who, drafts)
        if pool:
            return {"item_id": it["id"], "count": count}
        return {"item_id": it["id"], "status": "in", "home": views.home_label(state, it)}


def recount(item_id: str, count: Annotated[StrictInt, Field(ge=0)], reason: str) -> dict[str, Any]:
    """Record how many of a pool are in right now (FR-INV-35). Anyone signed in; pool only.

    What each holder has out is unchanged; owned becomes this count plus what is out.
    """
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        if not views.is_pool(it):
            raise BadRequest("recount is only for a pool")
        if not reason.strip():
            raise BadRequest("say why")
        _push(conn, who, [_draft("item", it["id"], "recounted", {"count": count, "reason": reason.strip()})])
        counts = views.pool_counts(_item(_state(conn), item_id))
        return {"item_id": it["id"], "in": counts["in"], "owned": counts["owned"]}


def list_members() -> dict[str, Any]:
    """Active members, by name: who gear can be transferred to."""
    with _open() as (conn, _who):
        return {"members": [{"user_id": u["id"], "name": u["name"]} for u in views.active_users(_state(conn))]}


def transfer(
    item_id: str,
    to_user_id: str | None = None,
    event: str | None = None,
    note: str | None = None,
    reservation_id: str | None = None,
) -> dict[str, Any]:
    """Move an item that is out to a new holder without it coming back first: to you when `to_user_id` is
    left out (take over, FR-OUT-12), or to another active member (FR-OUT-26); list_members has their ids.
    `event` is what it is going to now. It names the check-out it replaces, so it is not a conflict."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        if reservation_id is not None:
            _reservation(state, reservation_id)
        if it.get("retired"):
            raise BadRequest("retired items cannot be checked out")
        previous = it.get("movement")
        if it.get("status") != "out" or not previous:
            raise BadRequest("not out; check it out instead")
        to = to_user_id or who.user_id
        if to not in {u["id"] for u in views.active_users(state)}:
            raise NotFound(f"no active member with id {to}; call list_members")
        if to == it.get("holder_id"):
            raise Conflict("they already have it")
        movement_id = new_ulid()
        payload = {
            "holder_id": to,
            "event": (event or "").strip() or None,
            "supersedes": previous["id"],
            "reservation_id": reservation_id,
        }
        drafts = [_draft("item", it["id"], "checked_out", payload, movement_id)]
        if note and note.strip():
            drafts.append(_draft("item", it["id"], "note_added", {"text": note.strip(), "movement_id": movement_id}))
        _push(conn, who, drafts)
        return {"item_id": it["id"], "holder": views.user_name(state, to), "event": payload["event"]}


def _version(state: dict[str, Any], m: dict[str, Any]) -> dict[str, Any]:
    return {
        "movement_id": m["id"],
        "holder": views.user_name(state, m.get("holder_id")),
        "by": views.user_name(state, m.get("actor_id")),
        "event": m.get("event"),
        "at": views.iso(m.get("at")),
    }


def list_conflicts() -> dict[str, Any]:
    """Items two devices checked out with no signal and no check-in between, and nobody has settled
    (FR-OFF-10). The later holder is who the inventory shows now; settle_conflict decides."""
    with _open() as (conn, _who):
        state = _state(conn)
        return {
            "conflicts": [
                {
                    "item_id": c["item"]["id"],
                    "item": views.display_name(state, c["item"]),
                    "earlier": _version(state, c["earlier"]),
                    "later": _version(state, c["later"]),
                }
                for c in views.open_conflicts(state)
            ]
        }


def settle_conflict(item_id: str, outcome: Literal["back", "keep"], note: str | None = None) -> dict[str, Any]:
    """Settle a double check-out (FR-OFF-10): "back" checks it in, because it came back; "keep" says the
    later holder still has it. `note` tells the story on the item first, if it needs one."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        found = next((c for c in views.open_conflicts(state) if c["item"]["id"] == it["id"]), None)
        if found is None:
            raise BadRequest("no open conflict on this item")
        drafts = []
        if note and note.strip():
            drafts.append(_draft("item", it["id"], "note_added", {"text": note.strip()}))
        if outcome == "keep":
            later = found["later"]["id"]
            payload = {"field": "reviewed_movement", "value": later, "old": it.get("reviewed_movement")}
            drafts.append(_draft("item", it["id"], "field_changed", payload))
        else:
            drafts.append(_draft("item", it["id"], "checked_in", {}))
            if it.get("missing"):
                drafts.append(
                    _draft("item", it["id"], "field_changed", {"field": "missing", "value": False, "old": True})
                )
        _push(conn, who, drafts)
        return {"item_id": it["id"], "outcome": outcome}


def correct_event(item_id: str, event: str | None = None) -> dict[str, Any]:
    """Put right the event the item is out under (FR-OUT-41, FR-RES-17). The check-out stays in the log as
    it was. Gear packed for a reservation is not corrected this way; link_out_to_reservation moves it."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        movement = it.get("movement") or {}
        if it.get("status") != "out" or movement.get("type") != "checked_out":
            raise BadRequest("only gear that is out has an event to correct")
        if movement.get("reservation_id"):
            raise BadRequest("this is packed for a reservation; use link_out_to_reservation to move it")
        payload = {"movement_id": movement["id"], "event": (event or "").strip() or None, "reservation_id": None}
        _push(conn, who, [_draft("item", it["id"], "event_corrected", payload)])
        return {"item_id": it["id"], "event": payload["event"]}


def stock_check(location_id: str, seen: list[str], sub_location: str | None = None) -> dict[str, Any]:
    """Check one location, or one shelf of it, against what was seen there (FR-RPT-09).

    `seen` holds item ids or printed codes. Returns what was seen but lives elsewhere (misplaced), what
    was seen at home, what should be here, is in, and was not seen, and any reference that matched
    nothing. A missing item seen here is found again (FR-INV-19). Nothing else is recorded: a check is
    true for the walk, not stored.
    """
    with _open() as (conn, who):
        state = _state(conn)
        _home(state, location_id)
        shelf = (sub_location or "").strip()
        sighted: list[str] = []
        unknown: list[str] = []
        for ref in seen:
            item_id = ref
            if codes.is_code(ref):
                bound = codes.resolve(conn, ref)
                item_id = (bound or {}).get("item_id") or ""
            it = views.item(state, views.resolve_item(state, item_id)) if item_id else None
            if it is None or it.get("deleted"):
                unknown.append(ref)
            elif it["id"] not in sighted:
                sighted.append(it["id"])
        found_again = [i for i in sighted if (views.item(state, i) or {}).get("missing")]
        _push(
            conn,
            who,
            [
                _draft("item", i, "field_changed", {"field": "missing", "value": False, "old": True})
                for i in found_again
            ],
        )
        if found_again:
            state = _state(conn)

        def at_home(it: dict[str, Any]) -> bool:
            if it.get("home_location_id") != location_id:
                return False
            return not shelf or (it.get("sub_location") or "") == shelf

        def by_name(found: list[dict[str, Any]]) -> list[dict[str, Any]]:
            return sorted((_item_brief(state, it) for it in found), key=lambda b: b["name"].lower())

        seen_items = [views.item(state, i) or {} for i in sighted]
        not_seen = [
            it
            for it in views.items(state)
            if not it.get("retired")
            and not views.is_pool(it)
            and it.get("status") == "in"
            and at_home(it)
            and it["id"] not in sighted
        ]
        return {
            "misplaced": by_name([it for it in seen_items if not at_home(it)]),
            "seen_here": by_name([it for it in seen_items if at_home(it)]),
            "not_seen": by_name(not_seen),
            "found_again": found_again,
            "unknown": unknown,
        }


# --- admin tools (FR-MCP-10) -------------------------------------------------------------------------
#
# Everything below is refused for a User's token. Most of it calls accounts._require_admin, the same
# function the app's own endpoints call, for the same "Admins only" the app gives. Locations, categories,
# and group settings are events a device could in principle push; the app keeps them to Admins only in
# the browser (settings are also checked at the sync layer for `setting`, not for `location`/`category`),
# so the same accounts._require_admin call stands in for that check here too.


def _link(
    conn: sqlite3.Connection,
    state: dict[str, Any],
    kind: Literal["invite", "reset"],
    to: str,
    user_id: str,
    token: str,
) -> dict[str, Any]:
    """A one-time link built from the group's site address (FR-USR-12), mailed if mail is set up (FR-USR-15).

    Without a site address there is no page for the link to open, so only the
    token comes back, with a note saying why.
    """
    group = views.entity(state, "setting", "group") or {}
    code_url = group.get("code_url")
    link = f"{str(code_url).rstrip('/')}/join?token={token}" if code_url else None
    result: dict[str, Any] = {"user_id": user_id, "token": token, "link": link, "emailed": False}
    if link is None:
        result["note"] = "the group's site address is not set (Settings > Group); only the token is returned"
    elif mail.configured(conn):
        subject, body = mail.link_message(kind, views.group_name(state), link)
        try:
            mail.send(conn, to, subject, body)
            result["emailed"] = True
        except ApiError as exc:
            result["mail_error"] = exc.message
    return result


def _user_brief(u: dict[str, Any]) -> dict[str, Any]:
    return {"user_id": u["id"], "name": u.get("name"), "role": u.get("role"), "active": u.get("active")}


def list_users() -> dict[str, Any]:
    """Every account: name, email, role, whether it is active (FR-USR-04), and when a sign-in lock
    ends (`locked_until`, ms, or null when not locked). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        return {
            "users": [
                {
                    **_user_brief(u),
                    "email": u.get("email"),
                    "has_password": u.get("has_password"),
                    "locked_until": u.get("locked_until"),
                }
                for u in accounts.list_users(conn)
            ]
        }


def invite_user(name: str, email: str, role: accounts.Role = "user") -> dict[str, Any]:
    """Add a person and hand back a one-time link to set a password (FR-USR-04, FR-USR-12). Admins only."""
    with _open() as (conn, who):
        user_id, token = accounts.invite(conn, who, accounts.Invite(name=name, email=email, role=role))
        return _link(conn, _state(conn), "invite", email, user_id, token)


def reset_link(user_id: str) -> dict[str, Any]:
    """A fresh one-time link to set a new password (FR-USR-12). Admins only."""
    with _open() as (conn, who):
        token = accounts.reset_link(conn, who, user_id)
        return _link(conn, _state(conn), "reset", accounts.email_of(conn, user_id), user_id, token)


def set_user_active(user_id: str, active: StrictBool) -> dict[str, Any]:
    """Deactivate or reactivate an account (FR-USR-04).

    You cannot deactivate your own account (FR-USR-23), and the last Admin cannot be
    deactivated (FR-USR-03). Admins only.
    """
    with _open() as (conn, who):
        if active:
            accounts.reactivate(conn, who, user_id)
        else:
            accounts.deactivate(conn, who, user_id)
        return {"user": _user_brief(accounts.get_user(conn, user_id))}


def unlock_user(user_id: str) -> dict[str, Any]:
    """End a sign-in lock early, after too many wrong passwords (FR-USR-29). Admins only."""
    with _open() as (conn, who):
        accounts.unlock(conn, who, user_id)
        return {"user": _user_brief(accounts.get_user(conn, user_id))}


def set_user_role(user_id: str, role: accounts.Role) -> dict[str, Any]:
    """Change a person's role. You cannot drop your own Admin role (FR-USR-22), and the last Admin
    cannot be demoted (FR-USR-03). Admins only."""
    with _open() as (conn, who):
        accounts.set_role(conn, who, user_id, role)
        return {"user": _user_brief(accounts.get_user(conn, user_id))}


def update_user(user_id: str, fields: accounts.UserEdit) -> dict[str, Any]:
    """Fix a person's name, email, or both (FR-USR-04). Give only what changes. Admins only."""
    with _open() as (conn, who):
        accounts.edit_user(conn, who, user_id, fields)
        return {"user": {**_user_brief(accounts.get_user(conn, user_id)), "email": accounts.email_of(conn, user_id)}}


def list_devices(user_id: str) -> dict[str, Any]:
    """The devices one account is signed in on (FR-USR-14). Your own always; anyone's if you are an Admin."""
    with _open() as (conn, who):
        return {"devices": accounts.list_devices(conn, who, user_id)}


def revoke_device(user_id: str, device_id: str) -> dict[str, Any]:
    """Sign one device out, without touching the rest of the account (FR-USR-14). Your own always; anyone's if
    you are an Admin."""
    with _open() as (conn, who):
        return {"devices": accounts.revoke_device(conn, who, user_id, device_id)}


def _join_link_response(state: dict[str, Any], made: dict[str, Any]) -> dict[str, Any]:
    """A standing link's URL and QR, built from the group's site address, the same way _link
    builds an invite's (FR-USR-19). Without a site address there is no page for it to open."""
    group = views.entity(state, "setting", "group") or {}
    code_url = group.get("code_url")
    if not code_url:
        return {**made, "url": None, "note": "the group's site address is not set (Settings > Group)"}
    url = f"{str(code_url).rstrip('/')}/join?link={made['token']}"
    return {**made, "url": url, "qr_svg": labels.qr_svg(url)}


def create_join_link(
    expiry_days: accounts.JoinLinkExpiryDays = 7, label: accounts.JoinLinkLabel = ""
) -> dict[str, Any]:
    """A standing link and its QR, for a room of volunteers to make their own accounts at once
    (FR-USR-19). Good for 1, 7 (the default) or 30 days, or pass null for one that never expires,
    until revoked. Admins only.

    `label` says what the link is for, since the token is shown only here and a list of live
    links is otherwise told apart only by who made each one and when (FR-USR-21).
    """
    with _open() as (conn, who):
        made = accounts.create_join_link(conn, who, accounts.CreateJoinLink(expiry_days=expiry_days, label=label))
        return _join_link_response(_state(conn), made)


def list_join_links() -> dict[str, Any]:
    """Every live standing join link: its label, who made it, when, and when it expires (FR-USR-19). Admins only."""
    with _open() as (conn, who):
        return {"links": accounts.list_join_links(conn, who)}


def rename_join_link(link_id: str, label: accounts.JoinLinkLabel = "") -> dict[str, Any]:
    """Label a standing join link, or change the label it has (FR-USR-21). Pass an empty label to
    clear it. The link itself is unchanged: what was printed or passed around still works. Admins only."""
    with _open() as (conn, who):
        accounts.rename_join_link(conn, who, link_id, label)
        return {"links": accounts.list_join_links(conn, who)}


def revoke_join_link(link_id: str) -> dict[str, Any]:
    """End a standing join link before its expiry (FR-USR-19). Admins only."""
    with _open() as (conn, who):
        accounts.revoke_join_link(conn, who, link_id)
        return {"links": accounts.list_join_links(conn, who)}


def get_mail() -> dict[str, Any]:
    """The server's SMTP account, without the password (FR-USR-15). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        return {"mail": mail.describe(conn)}


def set_mail(
    host: str,
    from_address: str,
    port: StrictInt = 465,
    encryption: mail.Encryption = "ssl",
    username: str = "",
    password: str = "",
) -> dict[str, Any]:
    """Save the SMTP account an Admin fills in (FR-USR-15). A blank password keeps the one stored. Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        settings = mail.MailSettings(
            host=host, port=port, encryption=encryption, username=username, password=password, from_address=from_address
        )
        mail.save(conn, settings)
        return {"mail": mail.describe(conn)}


def clear_mail() -> dict[str, Any]:
    """Stop sending mail. Links go back to being copied by hand (FR-USR-12). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        mail.forget(conn)
        return {"mail": None}


def send_test_mail() -> dict[str, Any]:
    """Send a test message to your own address, to find a wrong password before someone else's reset needs it
    (FR-USR-16). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        to = accounts.email_of(conn, who.user_id)
        subject, body = mail.test_message(views.group_name(_state(conn)))
        mail.send(conn, to, subject, body)
        return {"sent_to": to}


def get_group() -> dict[str, Any]:
    """The group's name, site address, contact, how many days out counts as overdue, and its iPhone app's link."""
    with _open() as (conn, _who):
        group = views.entity(_state(conn), "setting", "group") or {}
        return {
            "name": group.get("name") or "",
            "code_url": group.get("code_url") or "",
            "contact": group.get("contact") or "",
            "overdue_days": group.get("overdue_days"),
            "iphone_app_url": group.get("iphone_app_url") or "",
        }


class GroupFields(BaseModel):
    """What an assistant may change on the group setting. Only what is given is changed (FR-USR-05)."""

    model_config = ConfigDict(extra="forbid", strict=True)

    name: NonBlank | None = None
    code_url: str | None = None
    contact: str | None = None
    overdue_days: Annotated[StrictInt, Field(ge=1)] | None = None
    # Where an iPhone's browser is sent to get the app (NFR-DEP-12). Blank or null clears it.
    iphone_app_url: HttpsUrlOrBlank = None


def set_group(fields: GroupFields) -> dict[str, Any]:
    """Change the group's name, site address, contact, overdue threshold, or iPhone app link (FR-USR-15,
    FR-PUB-01, FR-TAG-02, NFR-DEP-12).

    The server refuses anyone but an Admin, the same way it refuses a device
    that pushes a setting event.
    """
    with _open() as (conn, who):
        state = _state(conn)
        group = views.entity(state, "setting", "group")
        patch = fields.model_dump(exclude_unset=True)
        if not patch:
            raise BadRequest("say what to change")
        cleaned = {k: (v.strip() if isinstance(v, str) else v) for k, v in patch.items()}
        if group is None:
            _push(conn, who, [_draft("setting", "group", "created", cleaned)])
        else:
            drafts = [
                _draft("setting", "group", "field_changed", {"field": f, "value": v, "old": o})
                for f, v, o in _changes(group, cleaned)
            ]
            _push(conn, who, drafts)
        return get_group()


def list_calendar_feeds() -> dict[str, Any]:
    """Feeds an Admin has added, with a redacted URL (FR-RES-20, NFR-SEC-10). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        return {"feeds": calendars.list_feeds(conn)}


def add_calendar_feed(url: calendars.FeedUrl, label: calendars.FeedLabel = "") -> dict[str, Any]:
    """Add an ICS feed and fetch it once right away, so a bad URL shows up immediately (FR-RES-20). Admins only.

    The URL is checked in the argument model, so a refused one keeps its reason (see `_reported`).
    """
    with _open() as (conn, who):
        accounts._require_admin(who)
        return {"feed": calendars.add_feed(conn, calendars.FeedInput(url=url, label=label))}


def remove_calendar_feed(feed_id: str) -> dict[str, Any]:
    """Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        calendars.remove_feed(conn, feed_id)
        return {"feed_id": feed_id, "deleted": True}


def refresh_calendar_feeds() -> dict[str, Any]:
    """Fetch every feed again now, instead of waiting for the hourly refresh (FR-RES-20). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        return {"feeds": calendars.refresh_all(conn)}


def add_location(name: str) -> dict[str, Any]:
    """Add a place gear can call home (FR-SET-02). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        if not name.strip():
            raise BadRequest("a location needs a name")
        location_id = new_ulid()
        _push(conn, who, [_draft("location", location_id, "created", {"name": name.strip()})])
        return {"location_id": location_id, "name": name.strip()}


def rename_location(location_id: str, name: str) -> dict[str, Any]:
    """Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        state = _state(conn)
        loc = views.entity(state, "location", location_id)
        if loc is None:
            raise NotFound(f"no location with id {location_id}")
        if not name.strip():
            raise BadRequest("a location needs a name")
        drafts = [
            _draft("location", location_id, "field_changed", {"field": f, "value": v, "old": o})
            for f, v, o in _changes(loc, {"name": name.strip()})
        ]
        _push(conn, who, drafts)
        return {"location_id": location_id, "name": name.strip()}


def delete_location(location_id: str) -> dict[str, Any]:
    """Blocked while any item points at it; the error names them (FR-SET-05). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        state = _state(conn)
        if views.entity(state, "location", location_id) is None:
            raise NotFound(f"no location with id {location_id}")
        using = views.location_blockers(state, location_id)
        if using:
            raise Conflict("in use by " + ", ".join(views.display_name(state, it) for it in using))
        _push(
            conn,
            who,
            [_draft("location", location_id, "field_changed", {"field": "deleted", "value": True, "old": None})],
        )
        return {"location_id": location_id, "deleted": True}


def add_category(name: str) -> dict[str, Any]:
    """Define a group of similar gear (FR-SET-07). Anyone signed in, as in the item editor.

    A name already in use, whatever its case, returns that category rather than making a second one.
    """
    with _open() as (conn, who):
        name = name.strip()
        if not name:
            raise BadRequest("a category needs a name")
        for cat in views.categories(_state(conn)):
            if str(cat.get("name", "")).lower() == name.lower():
                return {"category_id": cat["id"], "name": cat["name"]}
        category_id = new_ulid()
        _push(conn, who, [_draft("category", category_id, "created", {"name": name})])
        return {"category_id": category_id, "name": name}


def rename_category(category_id: str, name: str) -> dict[str, Any]:
    """Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        state = _state(conn)
        cat = views.entity(state, "category", category_id)
        if cat is None:
            raise NotFound(f"no category with id {category_id}")
        if not name.strip():
            raise BadRequest("a category needs a name")
        drafts = [
            _draft("category", category_id, "field_changed", {"field": f, "value": v, "old": o})
            for f, v, o in _changes(cat, {"name": name.strip()})
        ]
        _push(conn, who, drafts)
        return {"category_id": category_id, "name": name.strip()}


def delete_category(category_id: str) -> dict[str, Any]:
    """Blocked while any item points at it; the error names them (FR-SET-05). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        state = _state(conn)
        if views.entity(state, "category", category_id) is None:
            raise NotFound(f"no category with id {category_id}")
        using = views.category_blockers(state, category_id)
        if using:
            raise Conflict("in use by " + ", ".join(views.display_name(state, it) for it in using))
        _push(
            conn,
            who,
            [_draft("category", category_id, "field_changed", {"field": "deleted", "value": True, "old": None})],
        )
        return {"category_id": category_id, "deleted": True}


def print_codes(sheets: StrictInt = 1) -> dict[str, Any]:
    """A PDF of fresh unassigned codes, laid out for 32-up label sheets (FR-TAG-02). Admins only.

    `sheets` is 1 to 10, 32 codes to a sheet. The group name, site address and
    contact must be set first (FR-PUB-01): a code is a public page the moment
    it goes on gear, and one with no way back to the group is no use to a
    finder. Binding a code to an item still happens by scanning it in the app.
    """
    with _open() as (conn, who):
        accounts._require_admin(who)
        if not 1 <= sheets <= 10:
            raise BadRequest("sheets must be between 1 and 10")
        group = views.entity(_state(conn), "setting", "group") or {}
        if not group.get("name") or not group.get("code_url") or not group.get("contact"):
            raise Conflict("set the group name, site address and contact in Settings first")
        made = codes.create_codes(conn, who.user_id, sheets * labels.LABELS_PER_SHEET)
        pdf = labels.sheet(made, str(group["code_url"]))
        return {"codes": made, "pdf_base64": base64.b64encode(pdf).decode("ascii")}


def export_csv() -> dict[str, Any]:
    """Every live item as a spreadsheet (FR-RPT-03). Any signed-in person, the same as the app."""
    with _open() as (conn, _who):
        return {"csv": inventory_csv.export(_state(conn))}


def preview_csv_import(text: str) -> dict[str, Any]:
    """What an import would do, without writing it: rows to add or change, and any errors (FR-SET-11). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        return inventory_csv.plan(_state(conn), text).summary()


def apply_csv_import(text: str) -> dict[str, Any]:
    """Write a file's adds and changes, as the Admin who ran it (FR-SET-11). Admins only.

    All or nothing: call preview_csv_import first, since one bad row stops the whole file.
    """
    with _open() as (conn, who):
        accounts._require_admin(who)
        return inventory_csv.apply(conn, text, who.user_id)


def read_audit_log(
    type: str | None = None,
    person_id: str | None = None,
    entity_type: str | None = None,
    from_day: datetime.date | None = None,
    to_day: datetime.date | None = None,
    offset: Annotated[StrictInt, Field(ge=0)] = 0,
) -> dict[str, Any]:
    """The whole log, newest first, as the app's audit screen shows it (FR-USR-24). Admins only.

    Narrow by event `type`, by the person who did it (`person_id`, from list_users), by `entity_type`,
    and by days where the group is, both inclusive. One page at a time; `more` says whether to call
    again with `offset` moved on by the page's length.
    """
    with _open() as (conn, who):
        accounts._require_admin(who)
        page, more = events.audit_page(
            conn,
            type=type,
            actor_id=person_id,
            entity_type=entity_type,
            first=from_day,
            last=to_day,
            offset=offset,
        )
        state = _state(conn)
        return {
            "events": [
                {
                    "event_id": e.id,
                    "at": views.iso(e.effective_at),
                    "type": e.type,
                    "entity_type": e.entity_type,
                    "entity_id": e.entity_id,
                    "item": views.name_of(state, e.entity_id) if e.entity_type == "item" else None,
                    "by": views.user_name(state, e.actor_id),
                    "payload": e.payload,
                }
                for e in page
            ],
            "more": more,
        }


TOOLS = [
    search_items,
    get_item,
    whats_out,
    list_reservations,
    get_reservation,
    list_repairs,
    list_locations,
    list_categories,
    create_reservation,
    update_reservation,
    add_to_reservation,
    remove_from_reservation,
    link_out_to_reservation,
    cancel_reservation,
    duplicate_reservation,
    create_item,
    add_unit,
    update_item,
    mark_missing,
    unassign_code,
    assign_code,
    retire_item,
    delete_item,
    merge_items,
    unmerge_item,
    make_generic,
    group_items,
    move_unit,
    make_single,
    make_pool,
    add_note,
    correct_note,
    delete_note,
    list_photos,
    get_photo,
    add_photo,
    remove_photo,
    raise_ticket,
    comment_ticket,
    set_ticket_state,
    list_found_reports,
    resolve_found_report,
    check_out,
    check_in,
    recount,
    list_members,
    transfer,
    list_conflicts,
    settle_conflict,
    correct_event,
    stock_check,
    get_notifications,
    set_notifications,
    list_users,
    invite_user,
    reset_link,
    update_user,
    set_user_active,
    unlock_user,
    set_user_role,
    list_devices,
    revoke_device,
    create_join_link,
    list_join_links,
    rename_join_link,
    revoke_join_link,
    get_mail,
    set_mail,
    send_test_mail,
    clear_mail,
    get_group,
    set_group,
    list_calendar_feeds,
    add_calendar_feed,
    remove_calendar_feed,
    refresh_calendar_feeds,
    add_location,
    rename_location,
    delete_location,
    add_category,
    rename_category,
    delete_category,
    print_codes,
    export_csv,
    preview_csv_import,
    apply_csv_import,
    read_audit_log,
]
"""Everything an assistant can do. What a User can do in the app, and what an Admin can do when the token's owner
is an Admin (FR-MCP-10); a User's token is refused the tools below the movement tools the same way the app refuses
a User."""


# --- the server ---------------------------------------------------------------------------------------


def _reported(tool: Callable[..., Any]) -> Callable[..., Any]:
    """A refusal keeps its reason. The SDK passes a ToolError's text to the caller and hides every
    other exception behind "Error executing tool", so the app's own errors are re-raised as one."""

    @functools.wraps(tool)
    def run(*args: Any, **kwargs: Any) -> Any:
        try:
            return tool(*args, **kwargs)
        except ApiError as exc:
            raise ToolError(exc.message) from exc

    return run


def build_server() -> MCPServer:
    """A server with every tool on it. One per app, so two apps in one process do not share a session manager."""
    server = MCPServer(name="Gear Tracker", instructions=INSTRUCTIONS, version="1")
    for tool in TOOLS:
        server.add_tool(_reported(tool))
    return server


Authenticator = Callable[[Request, sqlite3.Connection], Principal | None]


def _refuse(status: int, code: str, message: str) -> JSONResponse:
    """The same error shape as the rest of the API, so a client sees one server."""
    return JSONResponse({"error": code, "message": message, "server_time": now_ms()}, status_code=status)


class Endpoint:
    """The /mcp endpoint: a bearer token and a rate limit, then the SDK.

    The token goes through the same authenticator as every other route
    (FR-MCP-01). A bad one, or a deactivated account, is refused here, before
    the SDK sees the request. The caller then rides a context variable into the
    tool, which is where the database is opened.
    """

    def __init__(self, db_path: str | Path, authenticate: Authenticator, photo_dir: str | Path | None = None):
        self.db_path = Path(db_path)
        self.photo_dir = photo_files.store_dir(db_path, photo_dir)
        self.authenticate = authenticate
        self.limit = RateLimit(*CALLS_PER_MINUTE)
        self.server = build_server()
        # Building the SDK's own Starlette app is what constructs the session
        # manager. Its routes are not used: this endpoint is mounted in the
        # FastAPI app instead, so /mcp is one path on one server.
        self.server.streamable_http_app(
            streamable_http_path=MCP_PATH,
            stateless_http=True,
            # No SSE and no session id: one request, one JSON reply. Nothing for
            # a proxy to buffer, and nothing to keep between calls.
            json_response=True,
            # Nothing here is reachable without a bearer token, and the server
            # does not know its own hostname behind the group's proxy.
            transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        )

    @property
    def session_manager(self):
        """Started and stopped by the app's lifespan; the transport will not serve a request without it."""
        return self.server.session_manager

    def _principal(self, request: Request) -> Principal | None:
        conn = connect(self.db_path)
        try:
            who = self.authenticate(request, conn)
            if who is not None:
                # The access log names whoever authenticated (docs/deploy.md). This endpoint
                # is not behind the app's `principal` dependency, so it says who is calling
                # itself; an assistant's calls are a person's calls.
                request.state.user_email = accounts.email_or_none(conn, who.user_id)
            return who
        finally:
            conn.close()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        who = self._principal(Request(scope, receive))
        if who is None:
            await _refuse(401, "unauthorized", "this token is not valid")(scope, receive, send)
            return
        if not who.active:
            # A revoked token is already gone; this is the account itself (NFR-SEC-07).
            await _refuse(403, "deactivated", "this account has been deactivated")(scope, receive, send)
            return
        if not who.device_id.startswith(accounts.ASSISTANT_PREFIX):
            # A signed-in device keeps its own device_seq; the server keeps an assistant's. One
            # device cannot have both, so an ordinary device's token is refused here.
            await _refuse(
                403, "forbidden", "this is a sign-in token, not an assistant's; connect an assistant in Settings"
            )(scope, receive, send)
            return
        if not self.limit.allow(who.device_id, now_ms()):
            await _refuse(429, "rate_limited", "too many calls; try again in a minute")(scope, receive, send)
            return
        _CALLER.set(Caller(who=who, db_path=self.db_path, photo_dir=self.photo_dir))
        await self.session_manager.asgi_app(scope, receive, send)


def route(endpoint: Endpoint) -> Route:
    """Mounted as a route rather than a sub-app, so `/mcp` itself is the endpoint and nothing redirects."""
    return Route(MCP_PATH, endpoint=endpoint)
