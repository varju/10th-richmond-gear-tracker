"""Accounts: who may sign in, and what an Admin may do to them.

The person is an entity on the event log: name, role, active. Every change is
an event, so it is audited (FR-USR-05) and nobody is ever removed (FR-USR-06).
The credential — email, password hash, sessions, one-time links — is in
server-only tables and never reaches a device.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from pydantic import EmailStr, StringConstraints

from gear_tracker import derived, events
from gear_tracker.errors import BadRequest, Conflict, Deactivated, Forbidden, NotFound, Unauthorized
from gear_tracker.events import SERVER_DEVICE, NonEmpty, Strict, now_ms
from gear_tracker.sync import Principal
from gear_tracker.ulid import new_ulid

Role = Literal["admin", "user"]
Password = Annotated[str, StringConstraints(min_length=8)]
Email = Annotated[EmailStr, StringConstraints(max_length=254)]

LINK_TTL_MS = 7 * 24 * 3_600_000
"""An invite or reset link that has not been used in a week is dead. Sessions never expire; links do."""

ASSISTANT_PREFIX = "mcp-"
"""What makes a device_id an assistant's, not an ordinary device's (FR-MCP-02). The client reads the same prefix."""

_hasher = PasswordHasher()


# --- request bodies ----------------------------------------------------------------


class SignIn(Strict):
    email: Email
    password: str
    device_id: NonEmpty


class Redeem(Strict):
    token: NonEmpty
    password: Password
    device_id: NonEmpty


JoinLink = Annotated[str, StringConstraints(max_length=500, pattern=r"^https?://")]
"""A template for the page that redeems a one-time link, with TOKEN standing in for the token.

The app supplies it because only the app knows where it is served from: a host,
a path prefix, and its own route. The server fills TOKEN in and mails the
result (FR-USR-15). Nothing else is done with it.
"""


class Invite(Strict):
    name: NonEmpty
    email: Email
    role: Role = "user"
    # Given when the app wants the link mailed as well as shown (FR-USR-15).
    link: JoinLink | None = None


class ResetRequest(Strict):
    link: JoinLink | None = None


class RoleChange(Strict):
    role: Role


@dataclass(frozen=True)
class Session:
    token: str
    user: dict[str, Any]


# --- helpers ----------------------------------------------------------------------


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _new_token() -> str:
    return secrets.token_urlsafe(32)


def _require_admin(who: Principal) -> None:
    if who.role != "admin":
        raise Forbidden("Admins only")
    if not who.active:
        raise Deactivated("this account has been deactivated")


def _require_admin_or_self(who: Principal, user_id: str) -> None:
    """Devices are the one thing a User manages for themself (FR-USR-17); an Admin does it for anyone (FR-USR-14)."""
    if who.user_id == user_id:
        if not who.active:
            raise Deactivated("this account has been deactivated")
        return
    _require_admin(who)


def _check_device(device_id: str) -> None:
    if device_id == SERVER_DEVICE:
        raise BadRequest(f"{SERVER_DEVICE!r} is not a device")


def get_user(conn: sqlite3.Connection, user_id: str) -> dict[str, Any]:
    user = derived.get_entity(conn, "user", user_id)
    if user is None:
        raise NotFound("no such user")
    return {"id": user_id, **user}


def user_id_of(conn: sqlite3.Connection, email: str) -> str | None:
    """The account with this email, or None. Email is the identity the seed file and the CLI have."""
    row = conn.execute("SELECT user_id FROM accounts WHERE email = ?", (email.lower(),)).fetchone()
    return row["user_id"] if row is not None else None


def email_of(conn: sqlite3.Connection, user_id: str) -> str:
    row = conn.execute("SELECT email FROM accounts WHERE user_id = ?", (user_id,)).fetchone()
    if row is None:
        raise NotFound("no such user")
    return row["email"]


def list_users(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT e.entity_id AS id, e.state, a.email, a.password_hash IS NOT NULL AS has_password
        FROM entities e JOIN accounts a ON a.user_id = e.entity_id
        WHERE e.entity_type = 'user' ORDER BY a.email
        """
    )
    return [
        {"id": r["id"], **json.loads(r["state"]), "email": r["email"], "has_password": bool(r["has_password"])}
        for r in rows
    ]


def active_admins(conn: sqlite3.Connection) -> int:
    return conn.execute(
        """
        SELECT count(*) FROM entities
        WHERE entity_type = 'user'
          AND json_extract(state, '$.role') = 'admin'
          AND json_extract(state, '$.active') = 1
        """
    ).fetchone()[0]


def first_admin(conn: sqlite3.Connection) -> str | None:
    """The longest-standing active Admin. Who the server acts as when nobody said (a load from the command line)."""
    row = conn.execute(
        """
        SELECT a.user_id FROM accounts a JOIN entities e ON e.entity_id = a.user_id AND e.entity_type = 'user'
        WHERE json_extract(e.state, '$.role') = 'admin' AND json_extract(e.state, '$.active') = 1
        ORDER BY a.created_at, a.user_id LIMIT 1
        """
    ).fetchone()
    return row["user_id"] if row is not None else None


def _create_user(conn: sqlite3.Connection, actor_id: str, name: str, email: str, role: Role, now: int) -> str:
    user_id = new_ulid(now)
    try:
        conn.execute(
            "INSERT INTO accounts (user_id, email, created_at) VALUES (?, ?, ?)", (user_id, email.lower(), now)
        )
    except sqlite3.IntegrityError:
        raise Conflict("an account with that email already exists") from None
    events.append_server(conn, actor_id, "user", user_id, "created", {"name": name, "role": role, "active": True}, now)
    return user_id


def _change(conn: sqlite3.Connection, actor_id: str, user_id: str, field: str, value: Any, now: int) -> None:
    old = get_user(conn, user_id)[field]
    if old == value:
        return
    events.append_server(
        conn, actor_id, "user", user_id, "field_changed", {"field": field, "value": value, "old": old}, now
    )


def _issue_link(conn: sqlite3.Connection, user_id: str, kind: str, now: int) -> str:
    token = _new_token()
    conn.execute(
        "INSERT INTO links (token_hash, user_id, kind, created_at) VALUES (?, ?, ?, ?)",
        (_hash_token(token), user_id, kind, now),
    )
    return token


def _open_session(conn: sqlite3.Connection, user_id: str, device_id: str, now: int) -> Session:
    _check_device(device_id)
    token = _new_token()
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, device_id, created_at) VALUES (?, ?, ?, ?)",
        (_hash_token(token), user_id, device_id, now),
    )
    return Session(token=token, user=get_user(conn, user_id))


# --- install ----------------------------------------------------------------------------


def create_admin(conn: sqlite3.Connection, name: str, email: str, password: str, now: int | None = None) -> str:
    """The first Admin, from the command line (FR-USR-13). Refuses once one exists; use an invite after that."""
    if active_admins(conn):
        raise Conflict("an Admin already exists; invite the next one from the app")
    return install_admin(conn, name, email, password, now)


def install_admin(conn: sqlite3.Connection, name: str, email: str, password: str, now: int | None = None) -> str:
    """An Admin made at the server with a password already set: the command line, or the seed file."""
    now = now_ms() if now is None else now
    user_id = new_ulid(now)
    try:
        conn.execute(
            "INSERT INTO accounts (user_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
            (user_id, email.lower(), _hasher.hash(password), now),
        )
    except sqlite3.IntegrityError:
        raise Conflict("an account with that email already exists") from None
    # Nobody else exists to be the actor. The first Admin creates themself.
    events.append_server(
        conn, user_id, "user", user_id, "created", {"name": name, "role": "admin", "active": True}, now
    )
    return user_id


# --- signing in and out -----------------------------------------------------------------


def sign_in(conn: sqlite3.Connection, body: SignIn, now: int | None = None) -> Session:
    now = now_ms() if now is None else now
    row = conn.execute("SELECT user_id, password_hash FROM accounts WHERE email = ?", (body.email.lower(),)).fetchone()
    if row is None or row["password_hash"] is None:
        raise Unauthorized("wrong email or password")
    try:
        _hasher.verify(row["password_hash"], body.password)
    except VerifyMismatchError:
        raise Unauthorized("wrong email or password") from None
    if not get_user(conn, row["user_id"])["active"]:
        raise Deactivated("this account has been deactivated")
    return _open_session(conn, row["user_id"], body.device_id, now)


def redeem(conn: sqlite3.Connection, body: Redeem, now: int | None = None) -> Session:
    """Use an invite or reset link: set the password, open a session. The link is spent either way."""
    now = now_ms() if now is None else now
    link = conn.execute("SELECT * FROM links WHERE token_hash = ?", (_hash_token(body.token),)).fetchone()
    if link is None or link["used_at"] is not None or link["created_at"] + LINK_TTL_MS < now:
        raise Unauthorized("this link is not valid")
    if not get_user(conn, link["user_id"])["active"]:
        raise Deactivated("this account has been deactivated")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("UPDATE links SET used_at = ? WHERE token_hash = ?", (now, link["token_hash"]))
        conn.execute(
            "UPDATE accounts SET password_hash = ? WHERE user_id = ?", (_hasher.hash(body.password), link["user_id"])
        )
        if link["kind"] == "reset":
            # Whoever had the old password does not keep the sessions it opened.
            conn.execute(
                "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", (now, link["user_id"])
            )
        session = _open_session(conn, link["user_id"], body.device_id, now)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return session


def sign_out(conn: sqlite3.Connection, token: str, now: int | None = None) -> None:
    now = now_ms() if now is None else now
    conn.execute(
        "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", (now, _hash_token(token))
    )


def connect_assistant(conn: sqlite3.Connection, who: Principal, now: int | None = None) -> tuple[str, Session]:
    """A token a signed-in person mints for themselves, with no Admin involved (FR-MCP-01).

    It is an ordinary device session (FR-MCP-02), so it is in the device list
    and revoked like a lost device. The device_id says which one it is.
    """
    if not who.active:
        raise Deactivated("this account has been deactivated")
    now = now_ms() if now is None else now
    device_id = ASSISTANT_PREFIX + new_ulid(now)
    return device_id, _open_session(conn, who.user_id, device_id, now)


def authenticate(conn: sqlite3.Connection, token: str | None) -> Principal | None:
    """Bearer token in, Principal out. A deactivated user still gets one, marked inactive (FR-OFF-06)."""
    if not token:
        return None
    row = conn.execute(
        "SELECT user_id, device_id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL", (_hash_token(token),)
    ).fetchone()
    if row is None:
        return None
    user = derived.get_entity(conn, "user", row["user_id"])
    if user is None:
        return None
    return Principal(user_id=row["user_id"], device_id=row["device_id"], active=user["active"], role=user["role"])


# --- what Admins do ------------------------------------------------------------------------


def invite(conn: sqlite3.Connection, who: Principal, body: Invite, now: int | None = None) -> tuple[str, str]:
    """Create the user and hand back a one-time link for them (FR-USR-04, FR-USR-12)."""
    _require_admin(who)
    now = now_ms() if now is None else now
    user_id = _create_user(conn, who.user_id, body.name, body.email, body.role, now)
    return user_id, _issue_link(conn, user_id, "invite", now)


def reset_link(conn: sqlite3.Connection, who: Principal, user_id: str, now: int | None = None) -> str:
    _require_admin(who)
    now = now_ms() if now is None else now
    if not get_user(conn, user_id)["active"]:
        raise Conflict("reactivate the account first")
    return _issue_link(conn, user_id, "reset", now)


def _guard_last_admin(conn: sqlite3.Connection, user_id: str) -> None:
    """FR-USR-03. Nobody locks the group out."""
    user = get_user(conn, user_id)
    if user["role"] == "admin" and user["active"] and active_admins(conn) == 1:
        raise Conflict("this is the last Admin")


def set_role(conn: sqlite3.Connection, who: Principal, user_id: str, role: Role, now: int | None = None) -> None:
    _require_admin(who)
    now = now_ms() if now is None else now
    if role != "admin":
        _guard_last_admin(conn, user_id)
    _change(conn, who.user_id, user_id, "role", role, now)


def deactivate(conn: sqlite3.Connection, who: Principal, user_id: str, now: int | None = None) -> None:
    """Access ends at the server now (NFR-SEC-07). Sessions stay, so a final push can still land (FR-OFF-06)."""
    _require_admin(who)
    now = now_ms() if now is None else now
    _guard_last_admin(conn, user_id)
    _change(conn, who.user_id, user_id, "active", False, now)


def reactivate(conn: sqlite3.Connection, who: Principal, user_id: str, now: int | None = None) -> None:
    _require_admin(who)
    now = now_ms() if now is None else now
    _change(conn, who.user_id, user_id, "active", True, now)


# --- devices -------------------------------------------------------------------------------


def list_devices(conn: sqlite3.Connection, who: Principal, user_id: str) -> list[dict[str, Any]]:
    """The devices a user is signed in on: one row per device with an open session, latest sign-in first.

    A User sees their own (FR-USR-17); an Admin sees anyone's (FR-USR-14).
    """
    _require_admin_or_self(who, user_id)
    get_user(conn, user_id)
    rows = conn.execute(
        """
        SELECT device_id, max(created_at) AS created_at FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL
        GROUP BY device_id ORDER BY created_at DESC, device_id
        """,
        (user_id,),
    )
    return [{"device_id": r["device_id"], "created_at": r["created_at"]} for r in rows]


def revoke_device(
    conn: sqlite3.Connection, who: Principal, user_id: str, device_id: str, now: int | None = None
) -> list[dict[str, Any]]:
    """A lost or sold device. A User revokes their own (FR-USR-17); an Admin revokes anyone's (FR-USR-14).

    Its sessions end; the account and its history are untouched (FR-OFF-07).
    """
    _require_admin_or_self(who, user_id)
    now = now_ms() if now is None else now
    if user_id == who.user_id and device_id == who.device_id:
        raise Conflict("sign out instead")
    get_user(conn, user_id)
    conn.execute(
        "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL",
        (now, user_id, device_id),
    )
    return list_devices(conn, who, user_id)
