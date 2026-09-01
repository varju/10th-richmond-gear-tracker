"""Flags: things the machine noticed and a person should look at."""

from __future__ import annotations

import json
import sqlite3
from typing import Any


def add_flag(conn: sqlite3.Connection, event_id: str, kind: str, detail: dict[str, Any], now: int) -> None:
    conn.execute(
        "INSERT INTO flags (event_id, kind, detail, created_at) VALUES (?, ?, ?, ?)",
        (event_id, kind, json.dumps(detail, sort_keys=True), now),
    )


def list_flags(conn: sqlite3.Connection, kind: str | None = None) -> list[dict[str, Any]]:
    if kind is None:
        rows = conn.execute("SELECT * FROM flags ORDER BY id")
    else:
        rows = conn.execute("SELECT * FROM flags WHERE kind = ? ORDER BY id", (kind,))
    return [
        {
            "id": r["id"],
            "event_id": r["event_id"],
            "kind": r["kind"],
            "detail": json.loads(r["detail"]),
            "created_at": r["created_at"],
        }
        for r in rows
    ]
