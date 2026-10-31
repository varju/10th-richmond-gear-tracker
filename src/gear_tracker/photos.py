"""Photo files on the server (FR-INV-11). The app's upload and the assistant's both save through here."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from gear_tracker import derived, events
from gear_tracker.errors import BadRequest, NotFound, TooLarge
from gear_tracker.events import PHOTO_ENTITIES, PHOTO_TYPES
from gear_tracker.ulid import is_ulid

MAX_BYTES = 5 * 1024 * 1024
"""A phone shrinks a photo before sending it; this is the ceiling for one that did not."""

EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

TOO_LARGE = f"a photo may be at most {MAX_BYTES // (1024 * 1024)} MB"


def store_dir(db_path: str | Path, photos: str | Path | None = None) -> Path:
    """The file store: given, or a directory beside the database, so whatever backs up the one backs
    up the other."""
    return Path(photos) if photos is not None else Path(db_path).parent / "photos"


def path_of(photo_dir: Path, photo_id: str) -> Path | None:
    for ext in EXTENSIONS.values():
        candidate = photo_dir / f"{photo_id}{ext}"
        if candidate.is_file():
            return candidate
    return None


def content_type_of(path: Path) -> str:
    return next(ct for ct, ext in EXTENSIONS.items() if ext == path.suffix)


def save(
    conn: sqlite3.Connection,
    photo_dir: Path,
    actor_id: str,
    photo_id: str,
    entity_type: str,
    entity_id: str,
    content_type: str,
    data: bytes,
) -> None:
    """Keep the file and record the event. Idempotent on the id, like push: a retry finds the
    photo already on the entity and writes nothing."""
    if already(conn, photo_id, entity_type, entity_id, content_type):
        return
    if len(data) == 0:
        raise BadRequest("the photo is empty")
    if len(data) > MAX_BYTES:
        raise TooLarge(TOO_LARGE)
    photo_dir.mkdir(parents=True, exist_ok=True)
    (photo_dir / f"{photo_id}{EXTENSIONS[content_type]}").write_bytes(data)
    events.append_server(
        conn,
        actor_id,
        entity_type,
        entity_id,
        "photo_added",
        {"photo_id": photo_id, "content_type": content_type, "size": len(data)},
    )


def already(conn: sqlite3.Connection, photo_id: str, entity_type: str, entity_id: str, content_type: str) -> bool:
    """Everything about an upload that is known before its bytes arrive. True when it is already saved."""
    if not is_ulid(photo_id):
        raise BadRequest("photo_id must be a ULID")
    if entity_type not in PHOTO_ENTITIES:
        raise BadRequest(f"entity_type must be one of {', '.join(PHOTO_ENTITIES)}")
    if content_type not in PHOTO_TYPES:
        raise BadRequest(f"Content-Type must be one of {', '.join(PHOTO_TYPES)}")
    entity = derived.get_entity(conn, entity_type, entity_id)
    if entity is None:
        raise NotFound(f"no such {entity_type}")
    return any(ph["id"] == photo_id for ph in entity.get("photos", []))
