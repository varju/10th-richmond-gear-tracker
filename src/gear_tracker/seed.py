"""The config file a fresh instance starts from (NFR-DEP-10).

`GEAR_DATA/seed.toml` holds the first Admin, the group setting, and the mail
account. `gear-admin seed` reads it at every start, so it is idempotent: the
Admin is created only if no account has that email, and the group and mail are
written only where the file differs from what is stored. The Admin's password
is used once, at creation; a later change in the app is not undone by the file.

The file is a secret. It holds the Admin and mail passwords, so it sits in
`GEAR_DATA` beside the database and never in the repository.
"""

from __future__ import annotations

import sqlite3
import tomllib
from pathlib import Path
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from gear_tracker import accounts, derived, events, mail
from gear_tracker.errors import BadRequest
from gear_tracker.events import NonEmpty

GROUP_FIELDS = ("name", "code_url", "contact", "overdue_days")
"""What the file may set on the group setting. The app owns everything else."""


class Section(BaseModel):
    """A section of the file. An unknown key is a typo, not data, so it is refused."""

    model_config = ConfigDict(strict=True, frozen=True, extra="forbid")


class Admin(Section):
    name: NonEmpty
    email: accounts.Email
    password: accounts.Password


class Group(Section):
    name: NonEmpty
    code_url: str = ""
    contact: str = ""
    # Omitted means never flag (FR-OUT-14).
    overdue_days: Annotated[int, Field(ge=1)] | None = None


class Mail(mail.MailSettings):
    """The same account an Admin would fill in, from the file instead."""

    model_config = ConfigDict(strict=True, frozen=True, extra="forbid")


class Seed(Section):
    admin: Admin
    group: Group
    # No [mail] section means leave mail as it is, not stop sending.
    mail: Mail | None = None
    # A committed fixture to load into an empty database, or a path to one.
    # Parsed here; the loader is a later task.
    inventory: str | None = None


def read(path: str | Path) -> Seed:
    """Parse and validate a seed file. Raises BadRequest with one reason."""
    try:
        with open(path, "rb") as handle:
            raw = tomllib.load(handle)
    except FileNotFoundError:
        raise BadRequest(f"no seed file at {path}") from None
    except tomllib.TOMLDecodeError as exc:
        raise BadRequest(f"{path} is not valid TOML: {exc}") from None
    try:
        return Seed.model_validate(raw)
    except ValidationError as exc:
        raise BadRequest(f"{path}: {_first(exc)}") from None


def apply(conn: sqlite3.Connection, spec: Seed, now: int | None = None) -> list[str]:
    """Bring the database up to the file. Returns one line per thing it did."""
    now = events.now_ms() if now is None else now
    done: list[str] = []
    admin_id = accounts.user_id_of(conn, spec.admin.email)
    if admin_id is None:
        admin_id = accounts.install_admin(conn, spec.admin.name, spec.admin.email, spec.admin.password, now)
        done.append(f"created Admin {spec.admin.email}")
    done += _group(conn, admin_id, spec.group, now)
    done += _mail(conn, spec.mail, now)
    return done


def _group(conn: sqlite3.Connection, actor_id: str, group: Group, now: int) -> list[str]:
    """The group setting, as ordinary events by the server on the Admin's behalf."""
    wanted: dict[str, Any] = {
        "name": group.name.strip(),
        "code_url": _text(group.code_url),
        "contact": _text(group.contact),
        "overdue_days": group.overdue_days,
    }
    stored = derived.get_entity(conn, "setting", "group")
    if stored is None:
        events.append_server(conn, actor_id, "setting", "group", "created", wanted, now)
        return ["created the group setting"]
    done = []
    for field in GROUP_FIELDS:
        old = stored.get(field)
        if old == wanted[field]:
            continue
        payload = {"field": field, "value": wanted[field], "old": old}
        events.append_server(conn, actor_id, "setting", "group", "field_changed", payload, now)
        done.append(f"set group.{field}")
    return done


def _mail(conn: sqlite3.Connection, wanted: Mail | None, now: int) -> list[str]:
    if wanted is None or not _mail_differs(mail.get(conn), wanted):
        return []
    mail.save(conn, wanted, now)
    return ["set mail"]


def _mail_differs(stored: dict[str, Any] | None, wanted: Mail) -> bool:
    if stored is None:
        return True
    fields = ("host", "port", "encryption", "username")
    if any(stored[field] != getattr(wanted, field) for field in fields):
        return True
    if stored["from_address"] != str(wanted.from_address):
        return True
    # A blank password in the file keeps the stored one, as it does in the app.
    return bool(wanted.password) and stored["password"] != wanted.password


def _text(value: str) -> str | None:
    """Blank is absence, as it is in the app's own form."""
    return value.strip() or None


def _first(exc: ValidationError) -> str:
    """One reason, the first one. A volunteer fixes them one at a time."""
    error = exc.errors()[0]
    where = ".".join(str(part) for part in error["loc"])
    message = error["msg"].removeprefix("Value error, ")
    return f"{where}: {message}" if where else message
