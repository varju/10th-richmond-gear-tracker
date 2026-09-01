"""SQLite connections, opened the same way everywhere."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

# WAL lets readers carry on while a write is in flight, which is what makes one
# SQLite file survive a handful of volunteers syncing at once (NFR-PERF-08).
PRAGMAS = (
    "PRAGMA journal_mode = WAL",
    "PRAGMA foreign_keys = ON",
    "PRAGMA busy_timeout = 5000",
    "PRAGMA synchronous = NORMAL",
)


def connect(path: str | Path) -> sqlite3.Connection:
    """Open a database with our standard settings.

    isolation_level=None puts transaction control in our hands rather than the
    driver's; the migration runner depends on that.
    """
    path = Path(path)
    if path.parent != Path(""):
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    for pragma in PRAGMAS:
        conn.execute(pragma)
    return conn


@contextmanager
def open_db(path: str | Path) -> Iterator[sqlite3.Connection]:
    conn = connect(path)
    try:
        yield conn
    finally:
        conn.close()
