from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest
from argon2 import PasswordHasher

from gear_tracker import passwords
from gear_tracker.db import connect
from gear_tracker.migrate import migrate

# Real argon2, minimum work. Production parameters are tuned to be slow, and
# the suite hashes a password in most account tests.
passwords._hasher = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)


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


class Counting:
    """The test's real hasher, counting the checks it is asked to make. A password in `hold` waits at
    `gate` once inside its slot, so a test can line attempts up."""

    def __init__(self, hasher):
        self.hasher = hasher
        self.verified = 0
        self.hashed = 0
        self.running = 0
        self.most = 0
        self.hold: set[str] = set()
        self.gate = threading.Event()
        self._lock = threading.Lock()

    def hash(self, password):
        with self._lock:
            self.hashed += 1
        if password in self.hold:
            assert self.gate.wait(5), "the test never opened the gate"
        return self.hasher.hash(password)

    def verify(self, stored, password):
        with self._lock:
            self.verified += 1
            self.running += 1
            self.most = max(self.most, self.running)
        try:
            if password in self.hold:
                assert self.gate.wait(5), "the test never opened the gate"
            return self.hasher.verify(stored, password)
        finally:
            with self._lock:
                self.running -= 1


@pytest.fixture
def counting(monkeypatch):
    hasher = Counting(passwords._hasher)
    monkeypatch.setattr(passwords, "_hasher", hasher)
    yield hasher
    hasher.gate.set()
