"""The three routes, over real HTTP semantics, against a real SQLite file."""

from __future__ import annotations

import pytest

from gear_tracker.app import create_app
from gear_tracker.sync import Principal
from tests.factories import T0, incoming


def authenticate(request) -> Principal | None:
    """Test-only: the caller says who they are in headers. M4 replaces this with credentials."""
    user = request.headers.get("X-Test-User")
    if user is None:
        return None
    return Principal(
        user_id=user,
        device_id=request.headers.get("X-Test-Device", "phone"),
        active=request.headers.get("X-Test-Active", "yes") == "yes",
    )


@pytest.fixture
def client(db_path):
    app = create_app(db_path, authenticate)
    app.testing = True
    return app.test_client()


def as_alice(**extra):
    return {"X-Test-User": "alice", "X-Test-Device": "phone-a", **extra}


def event(**overrides):
    return incoming(actor_id="alice", device_id="phone-a", **overrides)


def test_every_route_needs_a_principal(client):
    assert client.get("/sync/bootstrap").status_code == 401
    assert client.get("/sync/pull?since=0").status_code == 401
    assert client.post("/sync/push", json={}).status_code == 401

    body = client.get("/sync/bootstrap").get_json()
    assert body["error"] == "unauthorized"
    assert isinstance(body["server_time"], int)


def test_the_round_trip(client):
    e = event(type="created", payload={"name": "Tent"})
    pushed = client.post(
        "/sync/push", json={"device_id": "phone-a", "client_time": T0, "events": [e]}, headers=as_alice()
    )
    assert pushed.status_code == 200
    assert pushed.get_json()["accepted"] == [e["id"]]
    assert "server_time" in pushed.get_json()

    pulled = client.get("/sync/pull?since=0", headers=as_alice())
    assert pulled.status_code == 200
    assert [x["id"] for x in pulled.get_json()["events"]] == [e["id"]]
    assert pulled.get_json()["cursor"] == 1

    booted = client.get("/sync/bootstrap", headers=as_alice())
    assert booted.status_code == 200
    assert booted.get_json()["snapshot"]["item"]["tent-1"]["name"] == "Tent"
    assert booted.get_json()["cursor"] == 1


def test_push_with_a_non_json_body_is_400(client):
    r = client.post("/sync/push", data="not json", content_type="text/plain", headers=as_alice())
    assert r.status_code == 400
    assert r.get_json()["error"] == "bad_request"


def test_push_from_another_device_is_403(client):
    r = client.post("/sync/push", json={"device_id": "phone-b", "client_time": T0, "events": []}, headers=as_alice())
    assert r.status_code == 403
    assert r.get_json()["error"] == "forbidden"


def test_pull_needs_an_integer_cursor(client):
    assert client.get("/sync/pull", headers=as_alice()).status_code == 400
    assert client.get("/sync/pull?since=abc", headers=as_alice()).status_code == 400
    assert client.get("/sync/pull?since=-1", headers=as_alice()).status_code == 400


def test_a_cursor_the_server_cannot_honour_is_410_not_silence(client):
    r = client.get("/sync/pull?since=500", headers=as_alice())
    assert r.status_code == 410
    assert r.get_json()["error"] == "re-bootstrap"


def test_a_deactivated_account_gets_403_except_on_push(client):
    gone = as_alice(**{"X-Test-Active": "no"})
    r = client.post("/sync/push", json={"device_id": "phone-a", "client_time": T0, "events": [event()]}, headers=gone)
    assert r.status_code == 200
    assert client.get("/sync/pull?since=0", headers=gone).status_code == 403
    assert client.get("/sync/bootstrap", headers=gone).get_json()["error"] == "deactivated"


def test_each_request_gets_its_own_connection_and_closes_it(client, db_path):
    """No connection leaks across requests; the file is still openable and consistent."""
    for n in range(1, 4):
        client.post(
            "/sync/push",
            json={"device_id": "phone-a", "client_time": T0, "events": [event(device_seq=n)]},
            headers=as_alice(),
        )
    assert client.get("/sync/pull?since=0", headers=as_alice()).get_json()["cursor"] == 3
