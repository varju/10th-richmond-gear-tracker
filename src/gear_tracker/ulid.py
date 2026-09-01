"""ULIDs: 48 bits of millisecond time, 80 bits of randomness, Crockford base32.

Events are minted on devices, so the server mostly checks these. It mints its
own only for events it originates, such as the first Admin at install.
"""

from __future__ import annotations

import os
import re
import time

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
LENGTH = 26
# The first character carries only 3 bits of time, so it cannot exceed '7'.
PATTERN = re.compile(r"^[0-7][0-9A-HJKMNP-TV-Z]{25}$")


def new_ulid(now_ms: int | None = None) -> str:
    if now_ms is None:
        now_ms = time.time_ns() // 1_000_000
    value = (now_ms << 80) | int.from_bytes(os.urandom(10))
    out = []
    for _ in range(LENGTH):
        out.append(ALPHABET[value & 31])
        value >>= 5
    return "".join(reversed(out))


def is_ulid(value: object) -> bool:
    return isinstance(value, str) and PATTERN.match(value) is not None
