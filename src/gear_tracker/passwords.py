"""Hashing and checking passwords, and what a new one must not be.

Argon2 is slow on purpose, so a burst of sign-ins could take every thread the
server has. At most CONCURRENT hashes or checks run at once (NFR-SEC-20).
"""

from __future__ import annotations

import functools
import secrets
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from gear_tracker.errors import BadRequest, CommonPassword, TooMany

MIN_LENGTH = 8
MAX_LENGTH = 256
"""Argon2 takes any length; a cap keeps a megabyte of password from costing more than a short one (NFR-SEC-21)."""

CONCURRENT = 3
WAIT_S = 10
"""How long a check waits for a free slot before the caller is told to try again."""

COMMON = Path(__file__).parent / "fixtures" / "common-passwords.txt"
"""The 100,000 most common passwords, most common first (NFR-SEC-22). Source and licence in
common-passwords.LICENSE beside it."""

_hasher = PasswordHasher()
_slots = threading.BoundedSemaphore(CONCURRENT)
_dummy: str | None = None


@contextmanager
def _slot() -> Iterator[None]:
    if not _slots.acquire(timeout=WAIT_S):
        raise TooMany("the server is busy; try again in a moment")
    try:
        yield
    finally:
        _slots.release()


def hash(password: str) -> str:  # noqa: A001 - the module is the namespace
    with _slot():
        return _hasher.hash(password)


def _dummy_hash() -> str:
    """A hash of nothing anyone knows, made once with the same settings as a real one."""
    global _dummy
    if _dummy is None:
        _dummy = _hasher.hash(secrets.token_urlsafe(32))
    return _dummy


def verify(stored: str | None, password: str) -> bool:
    """Whether the password matches. With no stored hash, a dummy is checked instead, so an email
    with no account, or no password yet, takes as long as a wrong password (NFR-SEC-19)."""
    with _slot():
        try:
            _hasher.verify(stored or _dummy_hash(), password)
        except VerifyMismatchError:
            return False
    return stored is not None


@functools.cache
def _common() -> frozenset[str]:
    # Shorter ones are refused anyway, so they are not kept.
    return frozenset(line.lower() for line in COMMON.read_text().splitlines() if len(line) >= MIN_LENGTH)


def check_new(password: str) -> None:
    """Refuse a password someone is about to set: too short, too long, or too common."""
    if len(password) < MIN_LENGTH:
        raise BadRequest(f"password must be at least {MIN_LENGTH} characters")
    if len(password) > MAX_LENGTH:
        raise BadRequest(f"password must be at most {MAX_LENGTH} characters")
    if password.lower() in _common():
        raise CommonPassword("this password is too common; choose another")
