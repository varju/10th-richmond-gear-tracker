"""What a request says about the client that sent it: its version, and a short name for its device.

The client sends HEADER on every request (NFR-DEP-16): `web <commit>` from a browser, `ios <version>
(<build>) <commit>` from the iPhone app. Older app builds send nothing. Only the version and the label
are kept, never the raw User-Agent (FR-USR-32).
"""

from __future__ import annotations

import re

HEADER = "X-Gear-Client"
MAX_VERSION = 64
APP_PLATFORM = "ios"

_PRINTABLE = re.compile(r"[ -~]+")

# First match wins. iOS browsers other than Safari name themselves before the Safari token they also carry.
_BROWSERS = (
    ("Edg", "Edge"),
    ("Firefox/", "Firefox"),
    ("FxiOS/", "Firefox"),
    ("CriOS/", "Chrome"),
    ("Chrome/", "Chrome"),
    ("Safari/", "Safari"),
)
# iPadOS asks for desktop pages, so its Safari says Macintosh and shows as a Mac.
_SYSTEMS = (
    ("iPhone", "iPhone"),
    ("iPad", "iPad"),
    ("Android", "Android"),
    ("CrOS", "Chromebook"),
    ("Windows", "Windows"),
    ("Macintosh", "Mac"),
    ("Linux", "Linux"),
)


def version(raw: str | None) -> str | None:
    """The header's value, or None when absent or not something worth keeping."""
    if raw is None:
        return None
    value = " ".join(raw.split())
    if not value or len(value) > MAX_VERSION or not _PRINTABLE.fullmatch(value):
        return None
    return value


def _first(user_agent: str, table: tuple[tuple[str, str], ...]) -> str | None:
    return next((name for token, name in table if token in user_agent), None)


def label(user_agent: str | None, client_version: str | None) -> str | None:
    """A short name such as "iPhone app" or "Chrome on Mac". None when the User-Agent says nothing we know."""
    ua = user_agent or ""
    system = _first(ua, _SYSTEMS)
    if client_version is not None and client_version.split(" ", 1)[0] == APP_PLATFORM:
        # In the app on an iPad, the web view asks for desktop pages too.
        return "iPad app" if system in ("iPad", "Mac") else "iPhone app"
    browser = _first(ua, _BROWSERS)
    if browser and system:
        return f"{browser} on {system}"
    return browser or system
