"""The three routes, over real HTTP semantics, against a real SQLite file."""

from __future__ import annotations

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from gear_tracker.app import create_app
from gear_tracker.sync import Principal
from tests.factories import T0, incoming


def authenticate(request: Request) -> Principal | None:
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
    return TestClient(create_app(db_path, authenticate))


def as_alice(**extra):
    return {"X-Test-User": "alice", "X-Test-Device": "phone-a", **extra}


def event(**overrides):
    return incoming(actor_id="alice", device_id="phone-a", **overrides)


def push_body(*events):
    return {"device_id": "phone-a", "client_time": T0, "events": list(events)}


def test_every_route_needs_a_principal(client):
    assert client.get("/sync/bootstrap").status_code == 401
    assert client.get("/sync/pull?since=0").status_code == 401
    assert client.post("/sync/push", json={}).status_code == 401

    body = client.get("/sync/bootstrap").json()
    assert body["error"] == "unauthorized"
    assert isinstance(body["server_time"], int)


def test_the_round_trip(client):
    e = event(type="created", payload={"name": "Tent"})
    pushed = client.post("/sync/push", json=push_body(e), headers=as_alice())
    assert pushed.status_code == 200
    assert pushed.json()["accepted"] == [e["id"]]
    assert "server_time" in pushed.json()

    pulled = client.get("/sync/pull?since=0", headers=as_alice())
    assert pulled.status_code == 200
    assert [x["id"] for x in pulled.json()["events"]] == [e["id"]]
    assert pulled.json()["cursor"] == 1

    booted = client.get("/sync/bootstrap", headers=as_alice())
    assert booted.status_code == 200
    assert booted.json()["snapshot"]["item"]["tent-1"]["name"] == "Tent"
    assert booted.json()["cursor"] == 1


def test_push_with_a_non_json_body_is_400(client):
    r = client.post("/sync/push", content=b"not json", headers=as_alice(**{"Content-Type": "application/json"}))
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"
    assert "server_time" in r.json()


def test_push_with_the_wrong_shape_is_400(client):
    r = client.post("/sync/push", json={"device_id": "phone-a", "events": []}, headers=as_alice())
    assert r.status_code == 400
    assert r.json()["message"] == "client_time: Field required"


def test_push_from_another_device_is_403(client):
    r = client.post("/sync/push", json={**push_body(), "device_id": "phone-b"}, headers=as_alice())
    assert r.status_code == 403
    assert r.json()["error"] == "forbidden"


def test_pull_needs_a_non_negative_integer_cursor(client):
    for bad in ("", "?since=abc", "?since=-1", "?since=1.5"):
        r = client.get(f"/sync/pull{bad}", headers=as_alice())
        assert r.status_code == 400, bad
        assert r.json()["error"] == "bad_request"


def test_a_cursor_the_server_cannot_honour_is_410_not_silence(client):
    r = client.get("/sync/pull?since=500", headers=as_alice())
    assert r.status_code == 410
    assert r.json()["error"] == "re-bootstrap"


def test_a_deactivated_account_gets_403_except_on_push(client):
    gone = as_alice(**{"X-Test-Active": "no"})
    assert client.post("/sync/push", json=push_body(event()), headers=gone).status_code == 200
    assert client.get("/sync/pull?since=0", headers=gone).status_code == 403
    assert client.get("/sync/bootstrap", headers=gone).json()["error"] == "deactivated"


def test_each_request_gets_its_own_connection(client):
    """Three requests, three connections, one consistent file."""
    for n in range(1, 4):
        client.post("/sync/push", json=push_body(event(device_seq=n)), headers=as_alice())
    assert client.get("/sync/pull?since=0", headers=as_alice()).json()["cursor"] == 3


def test_the_schema_is_published(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert set(paths) == {"/sync/bootstrap", "/sync/push", "/sync/pull"}
