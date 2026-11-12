"""Naming a device from its User-Agent and version header (FR-USR-32, NFR-DEP-16). Pure: no database."""

from __future__ import annotations

import pytest

from gear_tracker import clients

IPHONE_SAFARI = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/18.1 Mobile/15E148 Safari/604.1"
)
IPHONE_CHROME = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1"
)
IPHONE_WEBVIEW = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
)
IPAD_WEBVIEW = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
MAC_CHROME = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)
MAC_SAFARI = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/18.1 Safari/605.1.15"
)
WINDOWS_EDGE = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
)
ANDROID_CHROME = (
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
)
LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0"


@pytest.mark.parametrize(
    ("user_agent", "version", "expected"),
    [
        (IPHONE_WEBVIEW, "ios 1.0.4 (450) abc1234", "iPhone app"),
        (IPAD_WEBVIEW, "ios 1.0.4 (450) abc1234", "iPad app"),
        (IPHONE_SAFARI, "web abc1234", "Safari on iPhone"),
        (IPHONE_CHROME, "web abc1234", "Chrome on iPhone"),
        (MAC_CHROME, "web abc1234", "Chrome on Mac"),
        (MAC_SAFARI, None, "Safari on Mac"),
        (WINDOWS_EDGE, None, "Edge on Windows"),
        (ANDROID_CHROME, None, "Chrome on Android"),
        (LINUX_FIREFOX, None, "Firefox on Linux"),
        # An app build from before the header: the web view names no browser.
        (IPHONE_WEBVIEW, None, "iPhone"),
        ("curl/8.7.1", None, None),
        (None, None, None),
    ],
)
def test_a_device_is_named_by_its_kind(user_agent, version, expected):
    assert clients.label(user_agent, version) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("web abc1234", "web abc1234"),
        ("  ios 1.0.4  (450)\tabc1234 ", "ios 1.0.4 (450) abc1234"),
        (None, None),
        ("", None),
        ("x" * (clients.MAX_VERSION + 1), None),
        ("web café", None),
    ],
)
def test_only_a_short_plain_version_is_kept(raw, expected):
    assert clients.version(raw) == expected
