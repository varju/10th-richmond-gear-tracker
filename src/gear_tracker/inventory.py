"""Test data for a database with nothing in it (NFR-MAINT-10).

A different rule from [seed.py](seed.py). Config is secret and the file always
wins; this is public, committed, and the database always wins. It loads into a
database with no items and never again: after that the app is the truth, and a
changed file waits for the next wipe.

Locations and items only. No codes: those are printed and stuck on gear during
the labelling walk.
"""

from __future__ import annotations

import sqlite3
import tomllib
from importlib import resources
from pathlib import Path
from typing import Any

from pydantic import ValidationError, model_validator

from gear_tracker import events
from gear_tracker.errors import BadRequest, Conflict
from gear_tracker.events import IsoDate, NonEmpty
from gear_tracker.seed import Section, first_error
from gear_tracker.ulid import new_ulid

BUNDLED = "demo"
"""What `inventory = "demo"` means: the file shipped in the image. Anything else is a path."""


class Unit(Section):
    """One of several of the same thing (FR-INV-23). Home and shelf come from the generic unless set here."""

    number: int | NonEmpty
    """Text once stored, because the gear may be labelled "A" or "3b". A whole number in the file is fine."""

    nickname: str = ""
    home: str = ""
    sub_location: str = ""

    @property
    def label(self) -> str:
        return str(self.number).strip()


class Item(Section):
    """A single item, or a generic when it has units (FR-INV-21)."""

    name: NonEmpty
    description: str = ""
    home: str = ""
    sub_location: str = ""
    purchase_date: IsoDate | None = None
    price: float | int | None = None
    supplier: str = ""
    units: list[Unit] = []

    @model_validator(mode="after")
    def _numbered_once(self):
        numbers = [unit.label for unit in self.units]
        if len(set(numbers)) != len(numbers):
            raise ValueError(f"{self.name}: two units with the same number")
        return self


class Location(Section):
    name: NonEmpty


class Inventory(Section):
    locations: list[Location] = []
    items: list[Item] = []

    @model_validator(mode="after")
    def _homes_exist(self):
        names = {location.name for location in self.locations}
        if len(names) != len(self.locations):
            raise ValueError("two locations with the same name")
        for item in self.items:
            for home in [item.home, *(unit.home for unit in item.units)]:
                if home and home not in names:
                    raise ValueError(f"{item.name}: no location named {home!r}")
        return self


def read(source: str | Path) -> Inventory:
    """Parse and validate an inventory file. "demo" is the bundled one; anything else is a path."""
    path = bundled() if str(source) == BUNDLED else Path(source)
    try:
        raw = tomllib.loads(path.read_text())
    except FileNotFoundError:
        raise BadRequest(f"no inventory file at {path}") from None
    except tomllib.TOMLDecodeError as exc:
        raise BadRequest(f"{path} is not valid TOML: {exc}") from None
    try:
        return Inventory.model_validate(raw)
    except ValidationError as exc:
        raise BadRequest(f"{path}: {first_error(exc)}") from None


def bundled() -> Path:
    """The committed file, wherever the package was installed."""
    return Path(str(resources.files("gear_tracker") / "fixtures" / f"{BUNDLED}.toml"))


def has_items(conn: sqlite3.Connection) -> bool:
    return bool(conn.execute("SELECT 1 FROM entities WHERE entity_type = 'item' LIMIT 1").fetchone())


def load(conn: sqlite3.Connection, spec: Inventory, actor_id: str, now: int | None = None) -> str:
    """Write the file as events by the server, on the Admin's behalf. Refuses a database that has items."""
    if has_items(conn):
        raise Conflict("this database already has items; test data only loads into an empty one")
    now = events.now_ms() if now is None else now

    homes = {
        location.name: _created(conn, actor_id, "location", {"name": location.name}, now) for location in spec.locations
    }

    units = 0
    for item in spec.items:
        fields: dict[str, Any] = {"name": item.name}
        if item.units:
            fields["generic"] = True
        if item.description:
            fields["description"] = item.description
        _where(fields, homes, item.home, item.sub_location)
        for field in ("purchase_date", "price", "supplier"):
            if getattr(item, field):
                fields[field] = getattr(item, field)
        item_id = _created(conn, actor_id, "item", fields, now)

        for unit in item.units:
            under: dict[str, Any] = {"parent_id": item_id, "number": unit.label}
            if unit.nickname:
                under["nickname"] = unit.nickname
            _where(under, homes, unit.home or item.home, unit.sub_location or item.sub_location)
            _created(conn, actor_id, "item", under, now)
            units += 1

    generics = sum(1 for item in spec.items if item.units)
    return (
        f"loaded {_count(len(spec.locations), 'location')}, "
        f"{_count(generics, 'generic')} with {_count(units, 'unit')}, "
        f"{_count(len(spec.items) - generics, 'single item')}"
    )


def _count(number: int, thing: str) -> str:
    return f"{number} {thing}" if number == 1 else f"{number} {thing}s"


def _where(fields: dict[str, Any], homes: dict[str, str], home: str, sub_location: str) -> None:
    if home:
        fields["home_location_id"] = homes[home]
    if sub_location:
        fields["sub_location"] = sub_location


def _created(conn: sqlite3.Connection, actor_id: str, entity_type: str, payload: dict[str, Any], now: int) -> str:
    entity_id = new_ulid(now)
    events.append_server(conn, actor_id, entity_type, entity_id, "created", payload, now)
    return entity_id
