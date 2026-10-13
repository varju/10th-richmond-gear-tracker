"""A sliding-window rate limit, for the routes anyone can call: found reports (FR-PUB-04), joining, signing in."""

from __future__ import annotations

import threading
from collections import deque


class RateLimit:
    """At most `limit` hits per key in any `window_ms`. In memory, in this process.

    Requests run on several threads, so every method holds one lock.
    """

    def __init__(self, limit: int, window_ms: int):
        self.limit = limit
        self.window_ms = window_ms
        self._hits: dict[str, deque[int]] = {}
        self._lock = threading.RLock()

    def allow(self, key: str, now: int) -> bool:
        """Check and record in one step: say whether a hit was within the limit, and count it if so."""
        with self._lock:
            if not self.would_allow(key, now):
                return False
            self.record(key, now)
            return True

    def would_allow(self, key: str, now: int) -> bool:
        """Whether a hit would be within the limit, without recording it. For checking several limits before
        committing to any of them, so a hit refused by one does not spend the budget of the others."""
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            cutoff = now - self.window_ms
            while hits and hits[0] <= cutoff:
                hits.popleft()
            return len(hits) < self.limit

    def wait_ms(self, key: str, now: int) -> int:
        """How long until a hit would be allowed again. 0 when it would be now."""
        with self._lock:
            if self.would_allow(key, now):
                return 0
            hits = self._hits[key]
            return hits[len(hits) - self.limit] + self.window_ms - now

    def record(self, key: str, now: int) -> None:
        """Count a hit. Only correct to call after would_allow said yes for the same key and a close-by now."""
        with self._lock:
            self._hits.setdefault(key, deque()).append(now)
            self._forget(now)

    def refund(self, key: str, at: int) -> None:
        """Take back a hit `allow` counted at `at`, for one that turned out not to count."""
        with self._lock:
            hits = self._hits.get(key)
            if hits is not None and at in hits:
                hits.remove(at)

    def _forget(self, now: int) -> None:
        """Drop keys with nothing left in the window, so a long-running process does not grow."""
        cutoff = now - self.window_ms
        for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= cutoff]:
            del self._hits[key]
