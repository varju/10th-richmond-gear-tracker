"""Email a person chooses to get: a found report, a new repair ticket, a new account.

One message per event, no digest. Optional twice over: nothing is sent unless
a category is turned on (FR-USR-18), and nothing is sent when no SMTP account
is set up (mail.configured). Either way, the caller that triggered the event
must not wait on it or fail because of it: reads are done on the caller's
connection, then the sending itself runs on a background thread with no
database access, so a slow or dead mail server never holds up a found report
or a sync push.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from typing import Any, Literal, get_args

from gear_tracker import derived, mail, views
from gear_tracker.errors import ApiError
from gear_tracker.events import Strict

logger = logging.getLogger(__name__)

Category = Literal["found", "repair", "joined"]
CATEGORIES: tuple[Category, ...] = get_args(Category)


class Preferences(Strict):
    found: bool = False
    repair: bool = False
    joined: bool = False


def get(conn: sqlite3.Connection, user_id: str) -> dict[str, bool]:
    rows = conn.execute("SELECT category FROM notification_prefs WHERE user_id = ?", (user_id,)).fetchall()
    on = {r["category"] for r in rows}
    return {c: c in on for c in CATEGORIES}


def set_categories(conn: sqlite3.Connection, user_id: str, prefs: Preferences) -> dict[str, bool]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM notification_prefs WHERE user_id = ?", (user_id,))
        for category in CATEGORIES:
            if getattr(prefs, category):
                conn.execute("INSERT INTO notification_prefs (user_id, category) VALUES (?, ?)", (user_id, category))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return get(conn, user_id)


# --- sending -----------------------------------------------------------------------------


def _label(group: str) -> str:
    """ "10th Richmond Gear Tracker", or just "Gear Tracker" before a group name is set. Matches mail.py."""
    return f"{group} Gear Tracker" if group else "Gear Tracker"


def _group(conn: sqlite3.Connection) -> dict[str, Any]:
    return derived.get_entity(conn, "setting", "group") or {}


def _link(group: dict[str, Any], path: str) -> str | None:
    """A link into the app, only when the group has a site address to build one from."""
    code_url = group.get("code_url")
    return f"{str(code_url).rstrip('/')}{path}" if code_url else None


def _subscribers(conn: sqlite3.Connection, category: Category, exclude_user_id: str | None = None) -> list[str]:
    """Active users' email addresses, subscribed to this category, minus whoever caused the event."""
    rows = conn.execute(
        """
        SELECT p.user_id AS user_id, a.email AS email, e.state AS state
        FROM notification_prefs p
        JOIN accounts a ON a.user_id = p.user_id
        JOIN entities e ON e.entity_id = p.user_id AND e.entity_type = 'user'
        WHERE p.category = ?
        """,
        (category,),
    ).fetchall()
    out = []
    for r in rows:
        if r["user_id"] == exclude_user_id:
            continue
        if not json.loads(r["state"]).get("active", True):
            continue
        out.append(r["email"])
    return out


def _send(conn: sqlite3.Connection, category: Category, subject: str, body: str, exclude_user_id: str | None) -> None:
    """Read what sending needs now, then hand plain data to a thread that touches no database."""
    settings = mail.get(conn)
    if settings is None:
        return
    to = _subscribers(conn, category, exclude_user_id)
    if not to:
        return

    def run() -> None:
        for address in to:
            try:
                mail.send_with(settings, address, subject, body)
            except ApiError as exc:
                logger.warning("could not mail %s about %s: %s", address, category, exc.message)

    threading.Thread(target=run, daemon=True).start()


def gear_found(conn: sqlite3.Connection, item_id: str | None, note: str, contact: str) -> None:
    """A stranger reported gear found (FR-PUB-02). `item_id` may name a unit; its display name follows the generic."""
    state = derived.snapshot(conn)
    name = views.name_of(state, item_id) if item_id else "An item"
    group = _group(conn)
    lines = [f"{name} was reported found.", "", f"Note: {note}"]
    if contact:
        lines.append(f"Contact: {contact}")
    link = _link(group, f"/items/{item_id}") if item_id else None
    if link:
        lines += ["", link]
    _send(conn, "found", f"{_label(group.get('name', ''))}: gear reported found", "\n".join(lines) + "\n", None)


def repair_raised(conn: sqlite3.Connection, ticket_id: str, item_id: str, description: str, raised_by: str) -> None:
    """A new repair ticket (FR-REP-01), by an ordinary push or the `raise_ticket` assistant tool."""
    state = derived.snapshot(conn)
    raiser = views.entity(state, "user", raised_by) or {}
    group = _group(conn)
    lines = [
        f"{views.name_of(state, item_id)} has a new repair ticket.",
        "",
        f"Reported by: {raiser.get('name', 'someone')}",
        f"Problem: {description}",
    ]
    link = _link(group, f"/repairs/{ticket_id}")
    if link:
        lines += ["", link]
    _send(
        conn,
        "repair",
        f"{_label(group.get('name', ''))}: new repair ticket",
        "\n".join(lines) + "\n",
        raised_by,
    )


def user_joined(conn: sqlite3.Connection, user_id: str) -> None:
    """An invite link was redeemed for the first time. A reusable join link (built separately) calls this too."""
    user = derived.get_entity(conn, "user", user_id) or {}
    row = conn.execute("SELECT email FROM accounts WHERE user_id = ?", (user_id,)).fetchone()
    email = row["email"] if row is not None else ""
    group = _group(conn)
    lines = [f"{user.get('name', 'Someone')} joined {_label(group.get('name', ''))}.", "", f"Email: {email}"]
    link = _link(group, "/")
    if link:
        lines += ["", link]
    _send(conn, "joined", f"{_label(group.get('name', ''))}: new account", "\n".join(lines) + "\n", user_id)
