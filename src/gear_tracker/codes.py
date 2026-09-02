"""Printed codes: drawing them, recording them, and looking one up.

A code is an entity on the log. `created` means it was printed; `code_bound`
(from a device) puts it on an item. See docs/architecture.md, "Codes and labels".
"""

from __future__ import annotations

import re
import secrets
import sqlite3

from gear_tracker import derived, events
from gear_tracker.errors import BadRequest

CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
"""Crockford base32: no I, L, O or U, so a code read aloud or typed from a scuffed sticker is not ambiguous."""

CODE_LENGTH = 10
CODE_PATTERN = re.compile(r"^[0-9A-HJKMNP-TV-Z]{10}$")

MAX_CODES = 320
"""Ten sheets at a time. Enough for the whole inventory; small enough that a slip does not flood the log."""


def is_code(value: str) -> bool:
    return CODE_PATTERN.fullmatch(value) is not None


def new_code() -> str:
    """Random, not sequential (NFR-SEC-04). 50 bits: a guess does not land on a real code."""
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def create_codes(conn: sqlite3.Connection, actor_id: str, count: int, now: int | None = None) -> list[str]:
    """Draw `count` fresh codes and record each as printed. Returns them in the order drawn."""
    if not 1 <= count <= MAX_CODES:
        raise BadRequest(f"count must be between 1 and {MAX_CODES}")
    now = events.now_ms() if now is None else now
    codes: list[str] = []
    while len(codes) < count:
        code = new_code()
        if derived.get_entity(conn, "code", code) is not None:
            continue  # already printed once; draw again
        events.append_server(conn, actor_id, "code", code, "created", {}, now)
        codes.append(code)
    return codes


def resolve(conn: sqlite3.Connection, code: str) -> dict | None:
    """The code's derived state, with `item_id` once bound. None if we never printed it."""
    return derived.get_entity(conn, "code", code)
