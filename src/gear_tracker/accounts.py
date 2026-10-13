"""Accounts: who may sign in, and what an Admin may do to them.

The person is an entity on the event log: name, role, active. Every change is
an event, so it is audited (FR-USR-05) and nobody is ever removed (FR-USR-06).
The credential — email, password hash, sessions, one-time links — is in
server-only tables and never reaches a device.
"""

from __future__ import annotations

import hashlib
import json
import math
import secrets
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import pydantic
from pydantic import ConfigDict, EmailStr, StringConstraints, TypeAdapter

from gear_tracker import derived, events, notify, passwords
from gear_tracker.errors import (
    ApiError,
    BadRequest,
    Conflict,
    Deactivated,
    Forbidden,
    InviteUsed,
    Locked,
    NotFound,
    ResetUsed,
    Unauthorized,
)
from gear_tracker.events import SERVER_DEVICE, NonEmpty, Strict, now_ms
from gear_tracker.sync import Principal
from gear_tracker.ulid import new_ulid

Role = Literal["admin", "user"]
Password = Annotated[str, StringConstraints(min_length=passwords.MIN_LENGTH, max_length=passwords.MAX_LENGTH)]
Email = Annotated[EmailStr, StringConstraints(max_length=254)]
_email: TypeAdapter[str] = TypeAdapter(Email)

DAY_MS = 24 * 3_600_000

LINK_TTL_MS = 7 * DAY_MS
"""An invite or reset link that has not been used in a week is dead. Sessions never expire; links do."""

ASSISTANT_PREFIX = "mcp-"
"""What makes a device_id an assistant's, not an ordinary device's (FR-MCP-02). The client reads the same prefix."""

MINUTE_MS = 60_000

LOCK_AFTER = 5
FIRST_LOCK_MS = 15 * MINUTE_MS
LONGEST_LOCK_MS = DAY_MS
"""Five wrong passwords for one email lock it for 15 minutes; each further lock doubles that, up to a day
(NFR-SEC-12, NFR-SEC-13). Nothing locks for good: the group may have nobody at the keyboard."""

FORGET_LOCK_MS = 7 * DAY_MS
"""A count with no wrong password for a week is dropped, so made-up emails do not pile up."""


# --- request bodies ----------------------------------------------------------------


class SignIn(Strict):
    email: Email
    password: Annotated[str, StringConstraints(max_length=passwords.MAX_LENGTH)]
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


class UserEdit(Strict):
    """What an Admin may fix about a person (FR-USR-04). Either field, or both; at least one.

    `extra="forbid"` so an assistant's stray argument is refused, not silently dropped.
    """

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    name: NonEmpty | None = None
    email: Email | None = None


JoinLinkExpiryDays = Literal[1, 7, 30] | None
"""What an Admin picks at creation (FR-USR-19): 1, 7 or 30 days, or None for a link that never expires."""


JoinLinkLabel = Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]
"""What a link is for, in an Admin's words (FR-USR-21). Empty means unlabelled."""


class CreateJoinLink(Strict):
    expiry_days: JoinLinkExpiryDays = 7
    label: JoinLinkLabel = ""
    # Same idea as Invite.link: a template only the caller knows how to fill in. create_join_link
    # itself never reads this; it is here so the HTTP body carries what the route needs to build
    # the URL the QR encodes.
    link: JoinLink | None = None


class RenameJoinLink(Strict):
    """A new label for a link already handed out (FR-USR-21). Empty clears it."""

    label: JoinLinkLabel = ""


class Join(Strict):
    """What whoever opens a standing join link fills in (FR-USR-19): their own name, email and password."""

    link: NonEmpty
    name: NonEmpty
    email: Email
    password: Password
    device_id: NonEmpty


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


def email_or_none(conn: sqlite3.Connection, user_id: str) -> str | None:
    """The address for an access-log line, or None when there is no row to read it from.

    A log line should never break a request: a test's fake Principal has no row
    in `accounts`, and the request it signs still deserves a line.
    """
    try:
        return email_of(conn, user_id)
    except NotFound:
        return None


def list_users(conn: sqlite3.Connection, now: int | None = None) -> list[dict[str, Any]]:
    """`locked_until` is when a lock ends (NFR-SEC-12), or None when the account is not locked."""
    now = now_ms() if now is None else now
    rows = conn.execute(
        """
        SELECT e.entity_id AS id, e.state, a.email, a.password_hash IS NOT NULL AS has_password,
               CASE WHEN l.locked_until > ? THEN l.locked_until END AS locked_until
        FROM entities e JOIN accounts a ON a.user_id = e.entity_id
        LEFT JOIN sign_in_locks l ON l.email = a.email
        WHERE e.entity_type = 'user' ORDER BY a.email
        """,
        (now,),
    )
    return [
        {
            "id": r["id"],
            **json.loads(r["state"]),
            "email": r["email"],
            "has_password": bool(r["has_password"]),
            "locked_until": r["locked_until"],
        }
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
    passwords.check_new(password)
    user_id = new_ulid(now)
    try:
        conn.execute(
            "INSERT INTO accounts (user_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
            (user_id, email.lower(), passwords.hash(password), now),
        )
    except sqlite3.IntegrityError:
        raise Conflict("an account with that email already exists") from None
    # Nobody else exists to be the actor. The first Admin creates themself.
    events.append_server(
        conn, user_id, "user", user_id, "created", {"name": name, "role": "admin", "active": True}, now
    )
    return user_id


def grant_admin(conn: sqlite3.Connection, email: str, now: int | None = None) -> str:
    """Make an existing account an Admin from the server's keyboard, when nobody in the app can.

    The keyboard is the credential, as it is for `reset-link`, so there is no Principal and no
    self-demotion guard (FR-USR-22) to answer to. The change is an ordinary role event, actor the
    account itself, the way install_admin's first Admin creates themself. Returns the user id.
    """
    now = now_ms() if now is None else now
    user_id = user_id_of(conn, email)
    if user_id is None:
        raise NotFound(f"no account for {email}")
    _change(conn, user_id, user_id, "role", "admin", now)
    return user_id


# --- signing in and out -----------------------------------------------------------------


def wait_text(ms: int) -> str:
    """ "15 minutes", "1 minute", "2 hours": how long until a lock ends, rounded up."""
    minutes = max(1, math.ceil(ms / MINUTE_MS))
    if minutes < 60:
        return f"{minutes} minute{'' if minutes == 1 else 's'}"
    hours = math.ceil(minutes / 60)
    return f"{hours} hour{'' if hours == 1 else 's'}"


def _locked(wait_ms: int) -> Locked:
    return Locked(f"Too many attempts. Try again in {wait_text(wait_ms)}.")


def normal_email(email: str) -> str:
    """An email the way sign-in keys it: validated and normalised like a request body, then lowercased."""
    try:
        return str(_email.validate_python(email)).lower()
    except pydantic.ValidationError:
        raise BadRequest(f"not an email address: {email}") from None


def _lock_until(conn: sqlite3.Connection, email: str, now: int) -> int | None:
    """When this email's lock ends, or None when it is not locked."""
    row = conn.execute("SELECT locked_until FROM sign_in_locks WHERE email = ?", (email,)).fetchone()
    if row is not None and row["locked_until"] is not None and row["locked_until"] > now:
        return row["locked_until"]
    return None


def _immediate[T](conn: sqlite3.Connection, work: Callable[[], T]) -> T:
    conn.execute("BEGIN IMMEDIATE")
    try:
        out = work()
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return out


def _reserve(conn: sqlite3.Connection, email: str, now: int) -> int | None:
    """Count this attempt as wrong before its password is checked, in one transaction with the lock
    check, so attempts in parallel cannot all pass the check and get more than five tries. Refuses
    when locked. Returns when the lock ends if this attempt is the one that locked it; a right
    password then clears it (`_succeed`)."""

    def work() -> int | None:
        conn.execute("DELETE FROM sign_in_locks WHERE last_failed_at < ?", (now - FORGET_LOCK_MS,))
        until = _lock_until(conn, email, now)
        if until is not None:
            raise _locked(until - now)
        row = conn.execute("SELECT failures, locks FROM sign_in_locks WHERE email = ?", (email,)).fetchone()
        failures = max(row["failures"] if row else 0, 0) + 1
        locks = row["locks"] if row else 0
        locked_until = None
        if failures >= LOCK_AFTER:
            locks += 1
            failures = 0
            locked_until = now + min(FIRST_LOCK_MS * 2 ** (locks - 1), LONGEST_LOCK_MS)
        conn.execute(
            """
            INSERT INTO sign_in_locks (email, failures, locks, locked_until, last_failed_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (email) DO UPDATE SET
                failures = excluded.failures,
                locks = excluded.locks,
                locked_until = coalesce(excluded.locked_until, locked_until),
                last_failed_at = excluded.last_failed_at
            """,
            (email, failures, locks, locked_until, now),
        )
        return locked_until

    return _immediate(conn, work)


def _unreserve(conn: sqlite3.Connection, email: str, locked_by_me: int | None) -> None:
    """Take back a reservation whose password was never checked, such as when the server was busy.

    Adds and subtracts rather than setting, so refunds landing in either order give the same count.
    The count can dip below zero while a lock's own refund is still to come; `_reserve` reads it as zero.
    """

    def work() -> None:
        if locked_by_me is not None:
            conn.execute(
                "UPDATE sign_in_locks SET locks = locks - 1, failures = failures + ?, locked_until = NULL"
                " WHERE email = ? AND locked_until = ?",
                (LOCK_AFTER - 1, email, locked_by_me),
            )
        else:
            conn.execute("UPDATE sign_in_locks SET failures = failures - 1 WHERE email = ?", (email,))

    _immediate(conn, work)


def _succeed(conn: sqlite3.Connection, email: str, locked_by_me: int | None, now: int) -> None:
    """A right password clears the count, unless another attempt locked the email while this one
    was being checked: that lock stands."""

    def work() -> None:
        until = _lock_until(conn, email, now)
        if until is not None and until != locked_by_me:
            raise _locked(until - now)
        conn.execute("DELETE FROM sign_in_locks WHERE email = ?", (email,))

    _immediate(conn, work)


def _clear_lock(conn: sqlite3.Connection, email: str, now: int) -> bool:
    """Forget the count and any lock. Says whether it was locked."""
    locked = _lock_until(conn, email, now) is not None
    conn.execute("DELETE FROM sign_in_locks WHERE email = ?", (email,))
    return locked


def sign_in(conn: sqlite3.Connection, body: SignIn, now: int | None = None, address: str | None = None) -> Session:
    """A lock is checked first, before any hashing (NFR-SEC-15). Counting is by email, not account,
    so an unknown email gets the same answers in the same time as a known one (NFR-SEC-19).
    `address` is only for the Admins' mail when this locks an account (FR-USR-26).
    """
    now = now_ms() if now is None else now
    email = body.email.lower()
    locked_until = _reserve(conn, email, now)
    try:
        row = conn.execute("SELECT user_id, password_hash FROM accounts WHERE email = ?", (email,)).fetchone()
        right = passwords.verify(row["password_hash"] if row else None, body.password)
    except BaseException:
        _unreserve(conn, email, locked_until)
        raise
    if not right:
        if locked_until is None:
            raise Unauthorized("wrong email or password")
        # Known email or not, the same call: the mail's reads run on its own thread, not here.
        notify.account_locked(conn, email, wait_text(locked_until - now), address, now)
        raise _locked(locked_until - now)
    _succeed(conn, email, locked_until, now)
    if not get_user(conn, row["user_id"])["active"]:
        raise Deactivated("this account has been deactivated")
    return _open_session(conn, row["user_id"], body.device_id, now)


def unlock(conn: sqlite3.Connection, who: Principal, user_id: str, now: int | None = None) -> None:
    """End a lock early (FR-USR-29). Admins only. The count goes too, so the next lock is 15 minutes again."""
    _require_admin(who)
    _clear_lock(conn, email_of(conn, user_id), now_ms() if now is None else now)


def unlock_email(conn: sqlite3.Connection, email: str, now: int | None = None) -> bool:
    """The same from the server's keyboard (FR-USR-28), for any email, account or not. Says whether it was locked."""
    return _clear_lock(conn, normal_email(email), now_ms() if now is None else now)


def _already_used(kind: str) -> ApiError:
    """A link that worked once already. The reason differs by kind, so the Join page can act on it:
    an invite means the account exists (offer sign in); a reset has no self-service retry
    (an Admin must issue another). Either way the link itself is not the problem, so this is
    distinct from an expired or unknown link, which says nothing about why (FR-USR-12).
    """
    if kind == "invite":
        return InviteUsed("you already have an account; sign in instead")
    return ResetUsed("this reset link has already been used; ask an Admin for a new one")


def redeem(conn: sqlite3.Connection, body: Redeem, now: int | None = None) -> Session:
    """Use an invite or reset link: set the password, open a session. The link is spent either way.

    The check and the spend are one transaction, so two concurrent redeems of
    the same token cannot both pass: the loser's UPDATE matches no row. The
    password is hashed before that transaction, so a wait for a free hashing
    slot never holds the write lock; a quick check first keeps a bad link from
    costing a hash.
    """
    now = now_ms() if now is None else now
    passwords.check_new(body.password)
    token_hash = _hash_token(body.token)

    def usable() -> sqlite3.Row:
        link = conn.execute("SELECT * FROM links WHERE token_hash = ?", (token_hash,)).fetchone()
        if link is None or link["created_at"] + LINK_TTL_MS < now:
            raise Unauthorized("this link is not valid")
        if link["used_at"] is not None:
            raise _already_used(link["kind"])
        if not get_user(conn, link["user_id"])["active"]:
            raise Deactivated("this account has been deactivated")
        return link

    usable()
    password_hash = passwords.hash(body.password)
    conn.execute("BEGIN IMMEDIATE")
    try:
        link = usable()
        spent = conn.execute("UPDATE links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", (now, token_hash))
        if spent.rowcount == 0:
            # Lost the race: another redeem of the same token committed first.
            raise _already_used(link["kind"])
        conn.execute("UPDATE accounts SET password_hash = ? WHERE user_id = ?", (password_hash, link["user_id"]))
        # A new password is a fresh start: whatever guessing locked the old one is beside the point.
        _clear_lock(conn, email_of(conn, link["user_id"]), now)
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
    if link["kind"] == "invite":
        # First redemption of an invite is what "joined" means today (FR-USR-18). A reusable join
        # link, built separately, calls notify.user_joined itself when it makes its own account.
        notify.user_joined(conn, link["user_id"])
    return session


def join(conn: sqlite3.Connection, body: Join, now: int | None = None) -> Session:
    """Whoever opens a standing join link makes their own account (FR-USR-19).

    Unlike redeem, the link is not spent: it is good until it expires or an
    Admin revokes it. Unknown, expired, and revoked links all answer alike, so
    a made-up token learns nothing (the same rule FR-USR-12 gives redeem).
    """
    now = now_ms() if now is None else now
    passwords.check_new(body.password)
    link = conn.execute("SELECT * FROM join_links WHERE token_hash = ?", (_hash_token(body.link),)).fetchone()
    if link is None or link["revoked_at"] is not None or (link["expires_at"] is not None and link["expires_at"] <= now):
        raise Unauthorized("this link is not valid")
    # Hashed first: a busy server refuses it, and an account made before that would be left with no password.
    password_hash = passwords.hash(body.password)
    try:
        # The Admin who made the link is the actor, so the audit log (FR-USR-05) says who let them in.
        user_id = _create_user(conn, link["created_by"], body.name, body.email, "user", now)
    except Conflict:
        raise Conflict("an account with that email already exists; sign in instead") from None
    conn.execute("UPDATE accounts SET password_hash = ? WHERE user_id = ?", (password_hash, user_id))
    session = _open_session(conn, user_id, body.device_id, now)
    notify.user_joined(conn, user_id)
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


def create_join_link(conn: sqlite3.Connection, who: Principal, body: CreateJoinLink, now: int | None = None) -> dict:
    """A standing link a whole room can use to make their own accounts (FR-USR-19). Admins only.

    The token is returned only here, once, like an invite link (FR-USR-12); list_join_links
    never carries it again.
    """
    _require_admin(who)
    now = now_ms() if now is None else now
    link_id = new_ulid(now)
    token = _new_token()
    expires_at = None if body.expiry_days is None else now + body.expiry_days * DAY_MS
    conn.execute(
        "INSERT INTO join_links (id, token_hash, created_by, created_at, expires_at, label) VALUES (?, ?, ?, ?, ?, ?)",
        (link_id, _hash_token(token), who.user_id, now, expires_at, body.label),
    )
    return {
        "id": link_id,
        "token": token,
        "created_by": who.user_id,
        "created_at": now,
        "expires_at": expires_at,
        "label": body.label,
    }


def list_join_links(conn: sqlite3.Connection, who: Principal, now: int | None = None) -> list[dict]:
    """Live links: not revoked, not expired. Who made each one, and when it was made and dies.

    Never the token: once shown at creation, a standing link is otherwise
    known only by the id an Admin uses to revoke it.
    """
    _require_admin(who)
    now = now_ms() if now is None else now
    rows = conn.execute(
        """
        SELECT id, created_by, created_at, expires_at, label FROM join_links
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC
        """,
        (now,),
    ).fetchall()
    out = []
    for row in rows:
        creator = derived.get_entity(conn, "user", row["created_by"])
        out.append(
            {
                "id": row["id"],
                "created_by": row["created_by"],
                "created_by_name": creator["name"] if creator else None,
                "created_at": row["created_at"],
                "expires_at": row["expires_at"],
                "label": row["label"],
            }
        )
    return out


def rename_join_link(conn: sqlite3.Connection, who: Principal, link_id: str, label: str) -> None:
    """Label a link, or change the label it already has (FR-USR-21). Admins only.

    The token is unchanged: whatever was printed or passed around still works.
    """
    _require_admin(who)
    if conn.execute("SELECT 1 FROM join_links WHERE id = ?", (link_id,)).fetchone() is None:
        raise NotFound("no such join link")
    conn.execute("UPDATE join_links SET label = ? WHERE id = ?", (label, link_id))


def revoke_join_link(conn: sqlite3.Connection, who: Principal, link_id: str, now: int | None = None) -> None:
    """Admins only. A revoked link answers the same "not valid" as an unknown or expired one."""
    _require_admin(who)
    now = now_ms() if now is None else now
    if conn.execute("SELECT 1 FROM join_links WHERE id = ?", (link_id,)).fetchone() is None:
        raise NotFound("no such join link")
    conn.execute("UPDATE join_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", (now, link_id))


def _guard_last_admin(conn: sqlite3.Connection, user_id: str, message: str = "this is the last Admin") -> None:
    """FR-USR-03. Nobody locks the group out."""
    user = get_user(conn, user_id)
    if user["role"] == "admin" and user["active"] and active_admins(conn) == 1:
        raise Conflict(message)


def _change_email(conn: sqlite3.Connection, user_id: str, email: str) -> None:
    """Email is credential, not entity state (see accounts.py's docstring): it lives only in `accounts`,
    updated in place, never as a log event. So it never reaches a device, and this write carries no old
    value the way `_change` does — the row itself is not history.
    """
    email = email.lower()
    if email_of(conn, user_id) == email:
        return
    try:
        conn.execute("UPDATE accounts SET email = ? WHERE user_id = ?", (email, user_id))
    except sqlite3.IntegrityError:
        raise Conflict("an account with that email already exists") from None


def edit_user(conn: sqlite3.Connection, who: Principal, user_id: str, body: UserEdit, now: int | None = None) -> None:
    """Fix a person's name, email, or both (FR-USR-04). A name change is a field_changed event, old value
    and new (FR-USR-05), the same as a role change. Sessions are untouched either way (FR-USR-07).
    """
    _require_admin(who)
    if body.name is None and body.email is None:
        raise BadRequest("say what to change")
    now = now_ms() if now is None else now
    if body.name is not None:
        _change(conn, who.user_id, user_id, "name", body.name, now)
    if body.email is not None:
        _change_email(conn, user_id, body.email)


def set_role(conn: sqlite3.Connection, who: Principal, user_id: str, role: Role, now: int | None = None) -> None:
    _require_admin(who)
    now = now_ms() if now is None else now
    if role != "admin":
        if user_id == who.user_id:
            # FR-USR-22. The Users page goes with the role, so the mistake cannot be undone by the
            # person who made it. Another Admin does it, or `gear-admin grant-admin` at the server.
            raise Conflict("you cannot drop your own Admin role; another Admin must do it")
        # The guard and the write are one transaction, so two concurrent demotions of the last
        # two Admins cannot both read "someone else is still one" before either commits.
        conn.execute("BEGIN IMMEDIATE")
        try:
            _guard_last_admin(conn, user_id)
            _change(conn, who.user_id, user_id, "role", role, now)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        return
    _change(conn, who.user_id, user_id, "role", role, now)


def deactivate(conn: sqlite3.Connection, who: Principal, user_id: str, now: int | None = None) -> None:
    """Access ends at the server now (NFR-SEC-07). Device sessions stay, so a final push can still land
    (FR-OFF-06); assistant tokens end (see _deactivate).
    """
    _require_admin(who)
    if user_id == who.user_id:
        # FR-USR-23, and FR-USR-22's reason: signing yourself out of the app is not something you
        # can take back. Another Admin ends an account; to leave the group, delete your own from
        # Settings (deactivate_self), which says what it does first.
        raise Conflict("you cannot deactivate your own account; another Admin must do it")
    _deactivate(conn, who.user_id, user_id, now_ms() if now is None else now)


def deactivate_self(conn: sqlite3.Connection, who: Principal, token: str, now: int | None = None) -> None:
    """Delete my account (FR-USR-25): the same deactivation an Admin does, asked for by the person.

    Their name stays on every record. This device is signed out now, with their assistants. Their
    other devices keep one final push (FR-OFF-06), then sign out at their next sync. An Admin can
    reactivate them.
    """
    _deactivate(
        conn,
        who.user_id,
        who.user_id,
        now_ms() if now is None else now,
        last_admin="you are the last Admin; make someone else an Admin first",
        token=token,
    )


def _deactivate(
    conn: sqlite3.Connection,
    actor_id: str,
    user_id: str,
    now: int,
    last_admin: str = "this is the last Admin",
    token: str | None = None,
) -> None:
    """Every deactivation, whoever asks. The guard and the write are one transaction, for the same
    reason as set_role's demotion.

    Assistant tokens end now: they never hold unsent work (FR-OFF-06 is for phones), and
    reactivation then brings back the same devices whoever deactivated. `token` is the caller's
    own session, ended with them.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        if token is not None and not get_user(conn, user_id)["active"]:
            # Asked by the person: a second ask is from a session that should be gone.
            raise Deactivated("this account has been deactivated")
        _guard_last_admin(conn, user_id, last_admin)
        _change(conn, actor_id, user_id, "active", False, now)
        conn.execute(
            "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL"
            " AND (token_hash = ? OR substr(device_id, 1, ?) = ?)",
            (now, user_id, _hash_token(token) if token else None, len(ASSISTANT_PREFIX), ASSISTANT_PREFIX),
        )
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


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
