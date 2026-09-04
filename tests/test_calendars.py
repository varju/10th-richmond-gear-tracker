"""Calendar feeds: parsing a real ICS file, fetching from a real HTTP server, and reaching sync."""

from __future__ import annotations

import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from pydantic import ValidationError

from gear_tracker import calendars, sync
from gear_tracker.app import create_app
from gear_tracker.db import open_db
from gear_tracker.errors import NotFound
from gear_tracker.sync import Principal

FIXTURE = (Path(__file__).parent / "calendar_fixture.ics").read_text()
NOW = int(datetime(2026, 3, 20, 12, 0, tzinfo=UTC).timestamp() * 1000)
"""Fixed "now" for every test: 2026-09-10 (the single event) is within 180 days, and the weekly
meeting's first few occurrences (from 2026-02-01) are more than 7 days before it, so window
truncation is exercised without either boundary depending on the wall clock."""


# --- parsing, no network ------------------------------------------------------------------


def test_parse_ics_fixture_has_a_normal_all_day_and_recurring_event():
    found = calendars.parse_ics(FIXTURE, NOW)

    single = [e for e in found if e["uid"] == "troop-meeting-1@example.org"]
    assert single == [
        {
            "uid": "troop-meeting-1@example.org",
            "summary": "Troop Meeting",
            "starts": "2026-09-10",
            "ends": "2026-09-10",
            "all_day": False,
        }
    ]

    all_day = [e for e in found if e["uid"] == "spring-camp@example.org"]
    # DTEND on an all-day event is exclusive (20260504); the kept range ends the day before.
    assert all_day == [
        {
            "uid": "spring-camp@example.org",
            "summary": "Spring Camp",
            "starts": "2026-05-01",
            "ends": "2026-05-03",
            "all_day": True,
        }
    ]

    weekly = [e for e in found if e["uid"] == "weekly-meeting@example.org"]
    # The feed has 30 occurrences from 2026-02-01; only those inside the 7-day-back window survive.
    assert 1 < len(weekly) < 30
    assert all(e["starts"] >= "2026-03-13" for e in weekly)
    assert all(not e["all_day"] for e in weekly)


def test_redact_hides_the_query_string_where_a_private_token_lives():
    assert calendars.redact("https://cal.example.org/private/abc123/basic.ics?token=SECRET") == (
        "https://cal.example.org/private/abc123/basic.ics"
    )


def test_a_feed_url_must_be_http_or_https():
    with pytest.raises(ValidationError):
        calendars.FeedInput(url="javascript:alert(1)")


# --- fetching, over real HTTP ---------------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - http.server's naming
        if self.path == "/feed.ics":
            body = FIXTURE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/calendar")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args: object) -> None:  # quiet; pytest -s would otherwise be noisy
        pass


@pytest.fixture
def ics_server():
    """A real HTTP server on localhost, serving the fixture at /feed.ics and 404 elsewhere."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join()


def test_adding_a_feed_fetches_it_right_away(db, ics_server):
    feed = calendars.add_feed(db, calendars.FeedInput(url=f"{ics_server}/feed.ics", label="Troop"), now=NOW)
    assert feed["label"] == "Troop"
    assert feed["url_redacted"] == f"{ics_server}/feed.ics"
    assert feed["last_fetched_at"] == NOW
    assert feed["last_error"] is None

    kept = calendars.upcoming_events(db)
    assert any(e["summary"] == "Troop Meeting" for e in kept)
    assert any(e["summary"] == "Spring Camp" for e in kept)


def test_a_failed_fetch_records_the_error_and_keeps_the_old_events(db, ics_server):
    feed = calendars.add_feed(db, calendars.FeedInput(url=f"{ics_server}/feed.ics"), now=NOW)
    before = calendars.upcoming_events(db)
    assert before != []

    refetched = calendars.refresh_feed(db, feed["id"], now=NOW + 1000)
    assert refetched["last_error"] is None  # the good URL still works on a second fetch

    # Now the feed's URL breaks (the server took it down, say): the fetch fails, and the events
    # from the last successful one are left alone.
    db.execute("UPDATE calendar_feeds SET url = ? WHERE id = ?", (f"{ics_server}/missing.ics", feed["id"]))
    failed = calendars.refresh_feed(db, feed["id"], now=NOW + 2000)
    assert failed["last_error"] is not None
    assert calendars.upcoming_events(db) == before


def test_refresh_all_keeps_going_after_one_feed_fails(db, ics_server):
    calendars.add_feed(db, calendars.FeedInput(url=f"{ics_server}/feed.ics", label="Good"), now=NOW)
    calendars.add_feed(db, calendars.FeedInput(url=f"{ics_server}/missing.ics", label="Bad"), now=NOW)

    feeds = calendars.refresh_all(db, now=NOW + 1000)
    by_label = {f["label"]: f for f in feeds}
    assert by_label["Good"]["last_error"] is None
    assert by_label["Bad"]["last_error"] is not None


def test_removing_a_feed_drops_its_events(db, ics_server):
    feed = calendars.add_feed(db, calendars.FeedInput(url=f"{ics_server}/feed.ics"), now=NOW)
    assert calendars.upcoming_events(db) != []

    calendars.remove_feed(db, feed["id"])
    assert calendars.upcoming_events(db) == []


def test_removing_an_unknown_feed_is_not_found(db):
    with pytest.raises(NotFound):
        calendars.remove_feed(db, "no-such-feed")


# --- sync ------------------------------------------------------------------------------------


def test_events_appear_in_bootstrap_and_pull(db, db_path, ics_server):
    calendars.add_feed(db, calendars.FeedInput(url=f"{ics_server}/feed.ics", label="Troop"), now=NOW)
    principal = Principal(user_id="alice", device_id="phone-a")

    booted = sync.bootstrap(db, principal, now=NOW)
    assert any(e["summary"] == "Troop Meeting" for e in booted["calendar_events"])

    pulled = sync.pull(db, principal, 0, now=NOW)
    assert any(e["summary"] == "Spring Camp" for e in pulled["calendar_events"])


# --- routes: Admin only -----------------------------------------------------------------------


def authenticate(request: Request, _conn) -> Principal | None:
    user = request.headers.get("X-Test-User")
    if user is None:
        return None
    return Principal(user_id=user, device_id="phone-a", role=request.headers.get("X-Test-Role", "user"))


@pytest.fixture
def client(db_path):
    return TestClient(create_app(db_path, authenticate))


ADMIN = {"X-Test-User": "alice", "X-Test-Role": "admin"}
USER = {"X-Test-User": "bob", "X-Test-Role": "user"}


def test_calendars_routes_need_sign_in(client):
    assert client.get("/calendars").status_code == 401
    assert client.post("/calendars", json={"url": "https://example.org/x.ics"}).status_code == 401
    assert client.delete("/calendars/x").status_code == 401
    assert client.post("/calendars/refresh").status_code == 401


def test_calendars_routes_are_admin_only(client):
    assert client.get("/calendars", headers=USER).status_code == 403
    assert client.post("/calendars", json={"url": "https://example.org/x.ics"}, headers=USER).status_code == 403
    assert client.delete("/calendars/x", headers=USER).status_code == 403
    assert client.post("/calendars/refresh", headers=USER).status_code == 403


def test_an_admin_adds_lists_and_removes_a_feed(client, ics_server, db_path):
    added = client.post("/calendars", json={"url": f"{ics_server}/feed.ics", "label": "Troop"}, headers=ADMIN)
    assert added.status_code == 200, added.text
    feed = added.json()["feed"]
    assert feed["url_redacted"] == f"{ics_server}/feed.ics"
    assert feed["last_error"] is None

    listed = client.get("/calendars", headers=ADMIN).json()["feeds"]
    assert [f["id"] for f in listed] == [feed["id"]]

    refreshed = client.post("/calendars/refresh", headers=ADMIN)
    assert refreshed.status_code == 200
    assert refreshed.json()["feeds"][0]["last_error"] is None

    removed = client.delete(f"/calendars/{feed['id']}", headers=ADMIN)
    assert removed.status_code == 200
    assert client.get("/calendars", headers=ADMIN).json()["feeds"] == []

    with open_db(db_path) as conn:
        assert calendars.upcoming_events(conn) == []
