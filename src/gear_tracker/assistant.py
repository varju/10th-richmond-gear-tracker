"""Assistant access over MCP: the same inventory, asked for in words (FR-MCP-01 to FR-MCP-10).

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

**A pool moves by count.** Some gear is a counted stack rather than named units, like tent pegs
(FR-INV-34). `check_out`, `check_in` and `recount` move it by `count`, not by item id alone; the
server refuses a count on anything else and refuses a pool without one. `get_item` on a pool
reports owned, in, and out by holder in place of units and a code (FR-INV-36, FR-MCP-08).

**An Admin's token unlocks an Admin's work** (FR-MCP-10): users, mail, group
settings, locations, categories (adding one is anyone's job), printed codes,
CSV export and import, deleting an item, and merging or unmerging duplicates. Every one of those tools calls
the same accounts.py, mail.py, codes.py or inventory_csv.py function the app's
own endpoint calls, so a User's token is refused the same way the app refuses
a User: `accounts._require_admin` where the app checks it that way, and the
same server- or client-side rule mirrored in the tool where the app only
checks it in the browser (locations, categories, merge, unmerge, delete).
Unassigning a code (FR-MCP-09) is a User's job on any token, so
`unassign_code` sits with the rest of the User tools below.
"""

from __future__ import annotations

import base64
import json
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from gear_tracker import accounts, codes, derived, inventory_csv, labels, mail, sync, views
from gear_tracker import conflicts as clashes
from gear_tracker.db import connect
from gear_tracker.errors import ApiError, BadRequest, Conflict, NotFound
from gear_tracker.events import REPAIR_STATES, now_ms
from gear_tracker.ratelimit import RateLimit
from gear_tracker.sync import Principal
from gear_tracker.ulid import new_ulid

MCP_PATH = "/mcp"

CALLS_PER_MINUTE = (120, 60_000)
"""Generous: an assistant asks several questions to answer one. Per token, in this process."""

HISTORY_SHOWN = 10
"""How many of an item's movements a tool returns. The whole log is in the app."""

INSTRUCTIONS = """Gear Tracker holds a Scout group's gear: what we own, where it lives, who has it,
and what needs fixing. Search before you write, and use the ids the read tools
return. Everything you write is recorded as the signed-in person, through the
assistant. Users, mail, group settings, locations, renaming or deleting
categories, printed codes, CSV import, deleting an item, and merging duplicates
are an Admin's job in the app, and are here too when the signed-in person is an Admin; a User's token is
refused the same way the app refuses a User. A pool is gear kept as a counted stack, not named
units; check_out, check_in and recount move it by count."""


@dataclass(frozen=True)
class Caller:
    """Who is on the other end of this tool call, and where their data is."""

    who: Principal
    db_path: Path


_CALLER: ContextVar[Caller] = ContextVar("gear_tracker_mcp_caller")
"""Set by the guard in front of /mcp, read by every tool. The SDK copies the context into the tool."""


@contextmanager
def acting_as(who: Principal, db_path: str | Path) -> Iterator[None]:
    """Run the tool functions as this caller, outside an MCP request. The endpoint sets the same variable."""
    token = _CALLER.set(Caller(who=who, db_path=Path(db_path)))
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
            "out": [{"holder": views.user_name(state, o["holder_id"]), "count": o["count"]} for o in counts["out"]],
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
    out = []
    for row in rows:
        payload = json.loads(row["payload"])
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
    include_retired: bool = False,
) -> dict[str, Any]:
    """Find gear by name or home (FR-INV-07).

    Every word must appear somewhere in the name or the home. One row per thing
    the group owns several of, with how many are in, and single items as rows of
    their own. `status` is "in", "out", or "missing".
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
            # A pool has no units and no code of its own (FR-INV-34); owned, in, and out by holder
            # stand in for them (FR-INV-36).
            out["pool"] = True
            counts = views.pool_counts(it)
            out["owned"] = counts["owned"]
            out["in"] = counts["in"]
            out["out"] = [
                {"holder": views.user_name(state, o["holder_id"]), "count": o["count"]} for o in counts["out"]
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
            {"text": note["text"], "by": views.user_name(state, note.get("actor_id")), "at": views.iso(note.get("at"))}
            for note in it.get("notes") or []
        ]
        return out


def whats_out() -> dict[str, Any]:
    """What is out and who has it (FR-RPT-01), longest out first, with anything overdue flagged."""
    with _open() as (conn, _who):
        state = _state(conn)
        return views.what_is_out(state, now_ms())


def list_reservations(upcoming_only: bool = True) -> dict[str, Any]:
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


def list_repairs(open_only: bool = True) -> dict[str, Any]:
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

    model_config = ConfigDict(extra="forbid")

    item_id: str
    quantity: Annotated[int, Field(ge=1)]


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


def add_to_reservation(reservation_id: str, item_id: str, quantity: int | None = None) -> dict[str, Any]:
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

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    home_location_id: str | None = None
    sub_location: str | None = None
    purchase_date: IsoDate | None = None
    price: Annotated[float, Field(ge=0)] | None = None
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
    generic: bool = False,
    pool: bool = False,
    quantity: Annotated[int, Field(ge=0)] | None = None,
    category_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Add gear to the inventory (FR-INV-01).

    `generic` is for something the group owns several of: the name is stored
    once and each one becomes a numbered unit under it (FR-INV-21). Add those
    with add_unit. `pool` is for a counted stack instead, like tent pegs
    (FR-INV-34): give `quantity`, and it moves by count through check_out,
    check_in and recount, with no units and no code of its own; `pool` implies
    `generic`. `category_ids` puts it in any number of groups of similar gear
    (FR-SET-07); call list_categories for the ids.
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
        taken = {str(unit.get("number") or "").strip() for unit in views.units_of(state, parent["id"])}
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
            if any(
                str(unit.get("number") or "").strip() == patch["number"] and unit["id"] != it["id"]
                for unit in views.units_of(state, it["parent_id"])
            ):
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
    for gear written off; this is for a duplicate that was never real.
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
        _push(conn, who, [_draft("item", item_id, "field_changed", {"field": "deleted", "value": True, "old": None})])
        return {"item_id": item_id, "deleted": True}


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


Count = Annotated[int, Field(ge=1)]


def check_out(
    item_id: str, event: str | None = None, note: str | None = None, count: Count | None = None
) -> dict[str, Any]:
    """Take an item out, without a scan (FR-OUT-02). The holder is you; `event` is what it is going to.

    A pool (FR-INV-34) needs `count`; anything else refuses one (FR-MCP-08). Taking more than are
    in a pool warns, and is never blocked (FR-OUT-22).
    """
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
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
        payload: dict[str, Any] = {"holder_id": who.user_id, "event": (event or "").strip() or None}
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


def check_in(item_id: str, note: str | None = None, count: Count | None = None) -> dict[str, Any]:
    """Bring an item back, without a scan (FR-OUT-07). Anyone can check anything in (FR-OUT-08).

    A pool (FR-INV-34) defaults `count` to what you have out, and refuses if you have none; say
    `count` to return fewer and leave the rest against your name (FR-OUT-23).
    """
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        pool = views.is_pool(it)
        if it.get("generic") and not pool:
            raise BadRequest("that item does not move; one of its units does")
        if pool:
            have = next((o["count"] for o in views.pool_counts(it)["out"] if o["holder_id"] == who.user_id), 0)
            if count is None:
                if not have:
                    raise BadRequest("you have none of this out")
                count = have
            elif count > have:
                raise BadRequest(f"you have only {have} out")
        else:
            if count is not None:
                raise BadRequest("count is only for a pool (FR-OUT-22)")
            if it.get("status") != "out":
                raise Conflict("it is already in")
        movement_id = new_ulid()
        drafts = [_draft("item", it["id"], "checked_in", {"count": count} if pool else {}, movement_id)]
        if note and note.strip():
            drafts.append(_draft("item", it["id"], "note_added", {"text": note.strip(), "movement_id": movement_id}))
        if not pool and it.get("missing"):
            # It turned up (FR-INV-19).
            drafts.append(_draft("item", it["id"], "field_changed", {"field": "missing", "value": False, "old": True}))
        _push(conn, who, drafts)
        if pool:
            return {"item_id": it["id"], "count": count}
        return {"item_id": it["id"], "status": "in", "home": views.home_label(state, it)}


def recount(item_id: str, count: Annotated[int, Field(ge=0)], reason: str) -> dict[str, Any]:
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


# --- admin tools (FR-MCP-10) -------------------------------------------------------------------------
#
# Everything below is refused for a User's token. Most of it calls accounts._require_admin, the same
# function the app's own endpoints call, for the same "Admins only" the app gives. Locations, categories,
# and group settings are events a device could in principle push; the app keeps them to Admins only in
# the browser (settings are also checked at the sync layer for `setting`, not for `location`/`category`),
# so the same accounts._require_admin call stands in for that check here too.


def _link(
    conn: sqlite3.Connection, state: dict[str, Any], kind: str, to: str, user_id: str, token: str
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
    """Every account: name, email, role, and whether it is active (FR-USR-04). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        return {
            "users": [
                {**_user_brief(u), "email": u.get("email"), "has_password": u.get("has_password")}
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


def set_user_active(user_id: str, active: bool) -> dict[str, Any]:
    """Deactivate or reactivate an account (FR-USR-04).

    The last Admin cannot be deactivated (FR-USR-03). Admins only.
    """
    with _open() as (conn, who):
        if active:
            accounts.reactivate(conn, who, user_id)
        else:
            accounts.deactivate(conn, who, user_id)
        return {"user": _user_brief(accounts.get_user(conn, user_id))}


def set_user_role(user_id: str, role: accounts.Role) -> dict[str, Any]:
    """Change a person's role. The last Admin cannot be demoted (FR-USR-03). Admins only."""
    with _open() as (conn, who):
        accounts.set_role(conn, who, user_id, role)
        return {"user": _user_brief(accounts.get_user(conn, user_id))}


def list_devices(user_id: str) -> dict[str, Any]:
    """The devices one account is signed in on (FR-USR-14). Your own always; anyone's if you are an Admin."""
    with _open() as (conn, who):
        return {"devices": accounts.list_devices(conn, who, user_id)}


def revoke_device(user_id: str, device_id: str) -> dict[str, Any]:
    """Sign one device out, without touching the rest of the account (FR-USR-14). Your own always; anyone's if
    you are an Admin."""
    with _open() as (conn, who):
        return {"devices": accounts.revoke_device(conn, who, user_id, device_id)}


def get_mail() -> dict[str, Any]:
    """The server's SMTP account, without the password (FR-USR-15). Admins only."""
    with _open() as (conn, who):
        accounts._require_admin(who)
        return {"mail": mail.describe(conn)}


def set_mail(
    host: str,
    from_address: str,
    port: int = 465,
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
    """The group's name, site address, contact, and how many days out counts as overdue."""
    with _open() as (conn, _who):
        group = views.entity(_state(conn), "setting", "group") or {}
        return {
            "name": group.get("name") or "",
            "code_url": group.get("code_url") or "",
            "contact": group.get("contact") or "",
            "overdue_days": group.get("overdue_days"),
        }


class GroupFields(BaseModel):
    """What an assistant may change on the group setting. Only what is given is changed (FR-USR-05)."""

    model_config = ConfigDict(extra="forbid")

    name: NonBlank | None = None
    code_url: str | None = None
    contact: str | None = None
    overdue_days: Annotated[int, Field(ge=1)] | None = None


def set_group(fields: GroupFields) -> dict[str, Any]:
    """Change the group's name, site address, contact, or overdue threshold (FR-USR-15, FR-PUB-01, FR-TAG-02).

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


def print_codes(sheets: int = 1) -> dict[str, Any]:
    """A PDF of fresh unassigned codes, laid out for Avery 6576 (FR-TAG-02). Admins only.

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
        pdf = labels.sheet(made, str(group["name"]), str(group["code_url"]))
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
    cancel_reservation,
    duplicate_reservation,
    create_item,
    add_unit,
    update_item,
    mark_missing,
    unassign_code,
    delete_item,
    merge_items,
    unmerge_item,
    raise_ticket,
    comment_ticket,
    set_ticket_state,
    check_out,
    check_in,
    recount,
    list_users,
    invite_user,
    reset_link,
    set_user_active,
    set_user_role,
    list_devices,
    revoke_device,
    get_mail,
    set_mail,
    send_test_mail,
    get_group,
    set_group,
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
]
"""Everything an assistant can do. What a User can do in the app, and what an Admin can do when the token's owner
is an Admin (FR-MCP-10); a User's token is refused the tools below the movement tools the same way the app refuses
a User."""


# --- the server ---------------------------------------------------------------------------------------


def build_server() -> MCPServer:
    """A server with every tool on it. One per app, so two apps in one process do not share a session manager."""
    server = MCPServer(name="Gear Tracker", instructions=INSTRUCTIONS, version="1")
    for tool in TOOLS:
        server.add_tool(tool)
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

    def __init__(self, db_path: str | Path, authenticate: Authenticator):
        self.db_path = Path(db_path)
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
            return self.authenticate(request, conn)
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
        _CALLER.set(Caller(who=who, db_path=self.db_path))
        await self.session_manager.asgi_app(scope, receive, send)


def route(endpoint: Endpoint) -> Route:
    """Mounted as a route rather than a sub-app, so `/mcp` itself is the endpoint and nothing redirects."""
    return Route(MCP_PATH, endpoint=endpoint)
