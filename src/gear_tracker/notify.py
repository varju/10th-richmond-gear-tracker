"""Email a person chooses to get: a found report, a new repair ticket, a new account. And one they
do not choose: every Admin hears when an account is locked (FR-USR-26), at most once an hour.

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
from gear_tracker.db import connect
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


def _admins(conn: sqlite3.Connection) -> list[str]:
    """Every active Admin's email address."""
    rows = conn.execute(
        """
        SELECT a.email FROM accounts a JOIN entities e ON e.entity_id = a.user_id AND e.entity_type = 'user'
        WHERE json_extract(e.state, '$.role') = 'admin' AND json_extract(e.state, '$.active') = 1
        ORDER BY a.email
        """
    ).fetchall()
    return [r["email"] for r in rows]


def _send(conn: sqlite3.Connection, category: Category, subject: str, body: str, exclude_user_id: str | None) -> None:
    settings = mail.get(conn)
    if settings is None:
        return
    _send_to(settings, _subscribers(conn, category, exclude_user_id), category, subject, body)


def _send_to(settings: dict[str, Any], to: list[str], about: str, subject: str, body: str) -> None:
    """Hand plain data, read already, to a thread that touches no database."""
    if to:
        threading.Thread(target=_deliver, args=(settings, to, about, subject, body), daemon=True).start()


def _deliver(settings: dict[str, Any], to: list[str], about: str, subject: str, body: str) -> int:
    """Send to each address in turn. Returns how many went."""
    sent = 0
    for address in to:
        try:
            mail.send_with(settings, address, subject, body)
            sent += 1
        except ApiError as exc:
            logger.warning("could not mail %s about %s: %s", address, about, exc.message)
    return sent


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


LOCK_MAIL_EVERY_MS = 3_600_000
"""At most one lock mail an hour (FR-USR-30). Every Admin gets the same one, so this caps each Admin's
mail too. Otherwise anyone who can reach sign-in can fill the Admins' inboxes."""

_lock_mail: dict[str, tuple[int | None, int]] = {}
"""Per database file: when the last lock mail went, and how many locks since then were not mailed.
In memory, like the rate limits, so the cap is per running server; a restart can send one more."""
_lock_mail_guard = threading.Lock()


def account_locked(conn: sqlite3.Connection, email: str, wait: str, address: str | None, now: int) -> None:
    """An email was just locked by wrong passwords (FR-USR-26). Called alike whether or not it has an
    account; every read happens on a background thread with its own connection, so the sign-in that
    locked it takes the same time either way (NFR-SEC-19)."""
    path = conn.execute("PRAGMA database_list").fetchone()["file"]
    threading.Thread(target=_mail_lock, args=(path, email, wait, address, now), daemon=True).start()


def _mail_lock(path: str, email: str, wait: str, address: str | None, now: int) -> None:
    """Every active Admin, whatever their categories: this is about the group's security, not a choice of news."""
    try:
        conn = connect(path)
    except sqlite3.Error as exc:
        logger.warning("could not read %s to mail a lock: %s", path, exc)
        return
    try:
        settings = mail.get(conn)
        row = conn.execute("SELECT user_id FROM accounts WHERE email = ?", (email,)).fetchone()
        if settings is None or row is None:
            return
        user = derived.get_entity(conn, "user", row["user_id"]) or {}
        group = _group(conn)
        to = _admins(conn)
    finally:
        conn.close()
    if not to:
        return
    with _lock_mail_guard:
        last, skipped = _lock_mail.get(path, (None, 0))
        if last is not None and now - last < LOCK_MAIL_EVERY_MS:
            _lock_mail[path] = (last, skipped + 1)
            return
        _lock_mail[path] = (now, 0)
    lines = [f"{user.get('name', 'Someone')}'s account ({email}) is locked for {wait} after too many wrong passwords."]
    if address:
        lines.append(f"The last attempt came from {address}.")
    if skipped:
        were = "lock was" if skipped == 1 else "locks were"
        lines.append(f"{skipped} more {were} not mailed since the last of these.")
    lines += ["", "It unlocks by itself. An Admin can unlock it sooner from Settings > Users."]
    link = _link(group, "/settings/users")
    if link:
        lines += ["", link]
    subject = f"{_label(group.get('name', ''))}: account locked"
    if not _deliver(settings, to, "a lock", subject, "\n".join(lines) + "\n"):
        # Nobody got it, so it does not spend the hour: the next lock tries again, and counts this one.
        with _lock_mail_guard:
            if _lock_mail.get(path) == (now, 0):
                _lock_mail[path] = (last, skipped + 1)
