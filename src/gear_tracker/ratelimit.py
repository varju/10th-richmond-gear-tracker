"""A sliding-window rate limit, for the one route with no account behind it (FR-PUB-04)."""

from __future__ import annotations

from collections import deque


class RateLimit:
    """At most `limit` hits per key in any `window_ms`. In memory, in this process."""

    def __init__(self, limit: int, window_ms: int):
        self.limit = limit
        self.window_ms = window_ms
        self._hits: dict[str, deque[int]] = {}

    def allow(self, key: str, now: int) -> bool:
        """Check and record in one step: say whether a hit was within the limit, and count it if so."""
        if not self.would_allow(key, now):
            return False
        self.record(key, now)
        return True

    def would_allow(self, key: str, now: int) -> bool:
        """Whether a hit would be within the limit, without recording it. For checking several limits before
        committing to any of them, so a hit refused by one does not spend the budget of the others."""
        hits = self._hits.setdefault(key, deque())
        cutoff = now - self.window_ms
        while hits and hits[0] <= cutoff:
            hits.popleft()
        return len(hits) < self.limit

    def record(self, key: str, now: int) -> None:
        """Count a hit. Only correct to call after would_allow said yes for the same key and a close-by now."""
        self._hits.setdefault(key, deque()).append(now)
        self._forget(now)

    def _forget(self, now: int) -> None:
        """Drop keys with nothing left in the window, so a long-running process does not grow."""
        cutoff = now - self.window_ms
        for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= cutoff]:
            del self._hits[key]
