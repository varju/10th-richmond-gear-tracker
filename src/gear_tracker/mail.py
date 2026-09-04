"""Sending mail, so an invite or a reset link can go out on its own (FR-USR-15).

Optional by design. With nothing configured the server sends nothing and the
link is still shown to copy, which is how the group worked before this existed
(FR-USR-12). Nothing else in the app depends on mail working.

One SMTP account, filled in by an Admin: a provider's ordinary mailbox with an
app password is enough, and costs nothing to run (NFR-DEP-04). The password is
the one secret here that cannot be hashed, because SMTP AUTH needs it in the
clear. It lives in a server-only table and never reaches a device.
"""

from __future__ import annotations

import re
import smtplib
import sqlite3
import ssl
from email.message import EmailMessage
from typing import Annotated, Any, Literal

from pydantic import EmailStr, Field, StringConstraints

from gear_tracker.errors import BadRequest, Conflict
from gear_tracker.events import NonEmpty, Strict, now_ms

Encryption = Literal["none", "starttls", "ssl"]

TIMEOUT_S = 20
"""A device is waiting on the reply. Better a clear failure than a hung invite."""

Address = Annotated[EmailStr, StringConstraints(max_length=254)]


class MailSettings(Strict):
    """What an Admin fills in. Blank password means "keep the stored one", so it is never sent back out."""

    host: NonEmpty
    port: Annotated[int, Field(ge=1, le=65535)] = 465
    encryption: Encryption = "ssl"
    username: str = ""
    password: str = ""
    from_address: Address


def get(conn: sqlite3.Connection) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM mail WHERE id = 1").fetchone()
    return dict(row) if row else None


def describe(conn: sqlite3.Connection) -> dict[str, Any] | None:
    """What an Admin may read back: everything but the password."""
    row = get(conn)
    if row is None:
        return None
    return {
        "host": row["host"],
        "port": row["port"],
        "encryption": row["encryption"],
        "username": row["username"],
        "from_address": row["from_address"],
        "has_password": bool(row["password"]),
    }


def save(conn: sqlite3.Connection, body: MailSettings, now: int | None = None) -> None:
    now = now_ms() if now is None else now
    current = get(conn)
    password = body.password or (current["password"] if current else "")
    conn.execute(
        """
        INSERT INTO mail (id, host, port, encryption, username, password, from_address, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
            host = excluded.host, port = excluded.port, encryption = excluded.encryption,
            username = excluded.username, password = excluded.password,
            from_address = excluded.from_address, updated_at = excluded.updated_at
        """,
        (body.host, body.port, body.encryption, body.username, password, str(body.from_address), now),
    )


def forget(conn: sqlite3.Connection) -> None:
    """Stop sending. The links go back to being copied by hand."""
    conn.execute("DELETE FROM mail WHERE id = 1")


def configured(conn: sqlite3.Connection) -> bool:
    return get(conn) is not None


def _one_line(text: str) -> str:
    """Collapse whitespace, including a line break, to a single space.

    A subject is a header and free text is not: a group name with a line
    break in it would otherwise raise deep inside the email library instead
    of sending (a way to turn an invite into a failed request).
    """
    return re.sub(r"\s+", " ", text).strip()


def send(conn: sqlite3.Connection, to: str, subject: str, body: str) -> None:
    """One message, now, on the caller's thread. Raises Conflict if the server will not take it."""
    settings = get(conn)
    if settings is None:
        raise Conflict("no mail account is set up")
    send_with(settings, to, subject, body)


def send_with(settings: dict[str, Any], to: str, subject: str, body: str) -> None:
    """Like `send`, but with settings already read.

    For a caller sending off a background thread (notify.py): a database
    connection belongs to the thread that opened it, so the settings are read
    on the request's thread and handed here as plain data.
    """
    message = EmailMessage()
    message["From"] = settings["from_address"]
    message["To"] = to
    message["Subject"] = _one_line(subject)
    message.set_content(body)
    try:
        _deliver(settings, message)
    except (OSError, smtplib.SMTPException) as exc:
        raise BadRequest(f"the mail server refused it: {exc}") from None


def _deliver(settings: dict[str, Any], message: EmailMessage) -> None:
    host, port, encryption = settings["host"], settings["port"], settings["encryption"]
    context = ssl.create_default_context()
    if encryption == "ssl":
        with smtplib.SMTP_SSL(host, port, timeout=TIMEOUT_S, context=context) as smtp:
            _authenticate(smtp, settings)
            smtp.send_message(message)
        return
    with smtplib.SMTP(host, port, timeout=TIMEOUT_S) as smtp:
        if encryption == "starttls":
            smtp.starttls(context=context)
        _authenticate(smtp, settings)
        smtp.send_message(message)


def _authenticate(smtp: smtplib.SMTP, settings: dict[str, Any]) -> None:
    if settings["username"]:
        smtp.login(settings["username"], settings["password"])


def _named(group: str) -> str:
    """ "10th Richmond Gear Tracker", or just "Gear Tracker" before a group name is set."""
    return f"{group} Gear Tracker" if group else "Gear Tracker"


def link_message(kind: Literal["invite", "reset"], group: str, link: str) -> tuple[str, str]:
    """Subject and body for a one-time link (FR-USR-12). Plain text: it is three lines and a URL."""
    if kind == "invite":
        return (
            f"You have been added to {_named(group)}",
            f"You can now use the {group or 'group'} gear inventory.\n\n"
            f"Open this link to set a password and sign in:\n{link}\n\n"
            "It works once, and stops working in a week.\n",
        )
    return (
        f"Password reset for {_named(group)}",
        f"Someone asked for a new password on your {_named(group)} account.\n\n"
        f"Open this link to set one:\n{link}\n\n"
        "It works once, and stops working in a week. If you did not ask for it, ignore it.\n",
    )


def test_message(group: str) -> tuple[str, str]:
    return (
        "Gear Tracker test message",
        f"{_named(group)} can send mail. If you are reading this, the account works.\n",
    )
