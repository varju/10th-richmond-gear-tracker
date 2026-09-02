"""Assistant access over MCP: the same inventory, asked for in words (FR-MCP-01 to FR-MCP-06).

One process. The MCP server is mounted at `/mcp` in the same FastAPI app, over
Streamable HTTP, using the official SDK.

**A token is a device.** "Connect an assistant" in Settings opens a session
whose `device_id` is `mcp-<ulid>`. It authenticates through the same
`accounts.authenticate` as every other route, it is in the device list, and it
is revoked like a lost phone (FR-USR-14).

**A write is a push.** A tool builds events with that device_id and a
`device_seq` the server keeps per assistant, then hands them to `sync.push`. So
the entity rules, validation, attribution and drift checks all apply, and
history reads "this Scouter, via the assistant". There is no second write path.

**A read is derived state**, through views.py, which is the Python twin of what
the device reads on a phone.

**Nothing an Admin does is here** (FR-MCP-04): no users, mail, settings,
locations, or codes.
"""

from __future__ import annotations

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

from gear_tracker import accounts, derived, sync, views
from gear_tracker import conflicts as clashes
from gear_tracker.db import connect
from gear_tracker.errors import BadRequest, Conflict, NotFound
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
assistant. Users, mail, settings, locations and printed codes are an Admin's
job in the app, and are not here."""


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
    """Events from a tool, through the push a phone uses (FR-MCP-05). A refusal is the tool's error."""
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
    if it is None:
        raise NotFound(f"no item with id {item_id}")
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
    return brief


def _row(state: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    if row["kind"] == "single":
        return {"kind": "single", **_item_brief(state, row["item"])}
    return {
        "kind": "generic",
        "item_id": row["item"]["id"],
        "name": row["name"],
        "units": row["counts"]["total"],
        "in": row["counts"]["in"],
        "unit_ids": [u["id"] for u in row["units"]],
    }


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


def _reservation_brief(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "reservation_id": r["id"],
        "event": r.get("event"),
        "starts": r.get("starts"),
        "ends": r.get("ends"),
        "items": len(r.get("items") or []),
        "generics": sum(line["quantity"] for line in r.get("generics") or []),
    }


def _history(conn: sqlite3.Connection, state: dict[str, Any], item_id: str) -> list[dict[str, Any]]:
    """The item's last few movements, newest first (FR-INV-09). A merged duplicate's movements come too."""
    ids = views.aliases(state, item_id)
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        f"""
        SELECT * FROM events
        WHERE entity_type = 'item' AND entity_id IN ({marks}) AND type IN ('checked_out', 'checked_in')
        ORDER BY effective_at DESC, device_id DESC, device_seq DESC LIMIT ?
        """,
        (*ids, HISTORY_SHOWN),
    ).fetchall()
    out = []
    for row in rows:
        payload = json.loads(row["payload"])
        out.append(
            {
                "type": row["type"],
                "at": views.iso(row["effective_at"]),
                "by": views.user_name(state, row["actor_id"]),
                "holder": views.user_name(state, payload.get("holder_id")) or None,
                "event": payload.get("event"),
            }
        )
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
        if it.get("generic"):
            out["units"] = [_item_brief(state, unit) for unit in views.units_of(state, it["id"])]
        if it.get("parent_id"):
            out["generic_id"] = it["parent_id"]
            out["number"] = it.get("number")
        out["open_tickets"] = [_ticket_brief(state, t) for t in views.repairs_for(state, it["id"]) if views.is_open(t)]
        out["reservations"] = [
            _reservation_brief(r) for r in views.reservations(state) if it["id"] in views.named_items(state, r)
        ]
        out["history"] = [] if it.get("generic") else _history(conn, state, it["id"])
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
        return {"today": today, "reservations": [_reservation_brief(r) for r in found]}


def get_reservation(reservation_id: str) -> dict[str, Any]:
    """One reservation: its gear list, what is packed, what is still to pack, and any clash with another camp."""
    with _open() as (conn, _who):
        state = _state(conn)
        r = _reservation(state, reservation_id)
        rem = views.remaining(state, r)
        return {
            **_reservation_brief(r),
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


# --- reservation tools -----------------------------------------------------------------------------

IsoDate = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]


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
    supplier: str | None = None
    nickname: str | None = None
    number: Annotated[int, Field(ge=1)] | None = None


def _home(state: dict[str, Any], location_id: str | None) -> None:
    if location_id and views.entity(state, "location", location_id) is None:
        raise NotFound(f"no location with id {location_id}; call list_locations")


def create_item(
    name: str,
    home_location_id: str | None = None,
    sub_location: str | None = None,
    description: str | None = None,
    generic: bool = False,
) -> dict[str, Any]:
    """Add gear to the inventory (FR-INV-01).

    `generic` is for something the group owns several of: the name is stored
    once and each one becomes a numbered unit under it (FR-INV-21). Add those
    with add_unit.
    """
    with _open() as (conn, who):
        state = _state(conn)
        if not name.strip():
            raise BadRequest("an item needs a name")
        _home(state, home_location_id)
        payload: dict[str, Any] = {"name": name.strip()}
        if generic:
            payload["generic"] = True
        if home_location_id:
            payload["home_location_id"] = home_location_id
        if sub_location and sub_location.strip():
            payload["sub_location"] = sub_location.strip()
        if description and description.strip():
            payload["description"] = description.strip()
        item_id = new_ulid()
        _push(conn, who, [_draft("item", item_id, "created", payload)])
        return {"item_id": item_id, "name": payload["name"], "generic": generic}


def add_unit(generic_id: str, number: int | None = None, nickname: str | None = None) -> dict[str, Any]:
    """One more of something the group owns several of (FR-INV-22).

    It takes the next free number and its generic's home unless you say
    otherwise. A number is unique under its generic (FR-INV-23).
    """
    with _open() as (conn, who):
        state = _state(conn)
        parent = _item(state, generic_id)
        if not parent.get("generic"):
            raise BadRequest("that item is not one the group owns several of")
        taken = {unit.get("number") for unit in views.units_of(state, parent["id"])}
        if number is None:
            number = 1
            while number in taken:
                number += 1
        if number < 1:
            raise BadRequest("a number starts at 1")
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
        if "number" in patch and not it.get("parent_id"):
            raise BadRequest("only one of several has a number")
        if "number" in patch and any(
            unit.get("number") == patch["number"] and unit["id"] != it["id"]
            for unit in views.units_of(state, it["parent_id"])
        ):
            raise Conflict(f"#{patch['number']} is taken")
        drafts = [
            _draft("item", it["id"], "field_changed", {"field": field, "value": value, "old": old})
            for field, value, old in _changes(it, patch)
        ]
        _push(conn, who, drafts)
        return {"item_id": it["id"], "changed": [d["payload"]["field"] for d in drafts]}


def mark_missing(item_id: str) -> dict[str, Any]:
    """Say an item is lost (FR-INV-19). It stays in the inventory and clears on the next scan or check-in."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        if it.get("missing"):
            return {"item_id": it["id"], "missing": True, "already": True}
        _push(conn, who, [_draft("item", it["id"], "field_changed", {"field": "missing", "value": True, "old": None})])
        return {"item_id": it["id"], "missing": True}


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


def check_out(item_id: str, event: str | None = None, note: str | None = None) -> dict[str, Any]:
    """Take an item out, without a scan (FR-OUT-02). The holder is you; `event` is what it is going to."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        if it.get("generic"):
            raise BadRequest("that item does not move; one of its units does")
        if it.get("retired"):
            raise BadRequest("retired items cannot be checked out")
        if it.get("status") == "out":
            raise Conflict(f"already out with {views.user_name(state, it.get('holder_id'))}")
        movement_id = new_ulid()
        drafts = [
            _draft(
                "item",
                it["id"],
                "checked_out",
                {"holder_id": who.user_id, "event": (event or "").strip() or None},
                movement_id,
            )
        ]
        if note and note.strip():
            drafts.append(_draft("item", it["id"], "note_added", {"text": note.strip(), "movement_id": movement_id}))
        _push(conn, who, drafts)
        return {"item_id": it["id"], "status": "out", "event": (event or "").strip() or None}


def check_in(item_id: str, note: str | None = None) -> dict[str, Any]:
    """Bring an item back, without a scan (FR-OUT-07). Anyone can check anything in (FR-OUT-08)."""
    with _open() as (conn, who):
        state = _state(conn)
        it = _item(state, item_id)
        if it.get("generic"):
            raise BadRequest("that item does not move; one of its units does")
        if it.get("status") != "out":
            raise Conflict("it is already in")
        movement_id = new_ulid()
        drafts = [_draft("item", it["id"], "checked_in", {}, movement_id)]
        if note and note.strip():
            drafts.append(_draft("item", it["id"], "note_added", {"text": note.strip(), "movement_id": movement_id}))
        if it.get("missing"):
            # It turned up (FR-INV-19).
            drafts.append(_draft("item", it["id"], "field_changed", {"field": "missing", "value": False, "old": True}))
        _push(conn, who, drafts)
        return {"item_id": it["id"], "status": "in", "home": views.home_label(state, it)}


TOOLS = [
    search_items,
    get_item,
    whats_out,
    list_reservations,
    get_reservation,
    list_repairs,
    list_locations,
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
    raise_ticket,
    comment_ticket,
    set_ticket_state,
    check_out,
    check_in,
]
"""Everything an assistant can do. What a User can do in the app, and nothing an Admin does (FR-MCP-04)."""


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
            # A phone keeps its own device_seq; the server keeps an assistant's. One
            # device cannot have both, so a phone's token is refused here.
            await _refuse(403, "forbidden", "this is a phone's token; connect an assistant in Settings")(
                scope, receive, send
            )
            return
        if not self.limit.allow(who.device_id, now_ms()):
            await _refuse(429, "rate_limited", "too many calls; try again in a minute")(scope, receive, send)
            return
        _CALLER.set(Caller(who=who, db_path=self.db_path))
        await self.session_manager.asgi_app(scope, receive, send)


def route(endpoint: Endpoint) -> Route:
    """Mounted as a route rather than a sub-app, so `/mcp` itself is the endpoint and nothing redirects."""
    return Route(MCP_PATH, endpoint=endpoint)
