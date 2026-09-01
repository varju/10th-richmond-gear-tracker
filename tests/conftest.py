from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from argon2 import PasswordHasher

from gear_tracker import accounts
from gear_tracker.db import connect
from gear_tracker.migrate import migrate

# Real argon2, minimum work. Production parameters are tuned to be slow, and
# the suite hashes a password in most account tests.
accounts._hasher = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)


def write(directory: Path, name: str, sql: str) -> Path:
    path = directory / name
    path.write_text(sql)
    return path


@pytest.fixture
def migrations(tmp_path) -> Path:
    d = tmp_path / "migrations"
    d.mkdir()
    return d


@pytest.fixture
def db_path(tmp_path) -> Path:
    """A fresh database with the shipped migrations applied.

    A file, not :memory:, so WAL and busy_timeout are the ones we ship.
    """
    path = tmp_path / "test.db"
    migrate(path)
    return path


@pytest.fixture
def db(db_path) -> Iterator[sqlite3.Connection]:
    conn = connect(db_path)
    try:
        yield conn
    finally:
        conn.close()
