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
        """Record a hit and say whether it was within the limit. A refused hit is not recorded."""
        hits = self._hits.setdefault(key, deque())
        cutoff = now - self.window_ms
        while hits and hits[0] <= cutoff:
            hits.popleft()
        if len(hits) >= self.limit:
            return False
        hits.append(now)
        self._forget(now)
        return True

    def _forget(self, now: int) -> None:
        """Drop keys with nothing left in the window, so a long-running process does not grow."""
        cutoff = now - self.window_ms
        for key in [k for k, hits in self._hits.items() if not hits or hits[-1] <= cutoff]:
            del self._hits[key]
