"""The three routes, over real HTTP semantics, against a real SQLite file."""

from __future__ import annotations

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from gear_tracker import accounts
from gear_tracker.app import create_app
from gear_tracker.db import open_db
from gear_tracker.sync import Principal
from tests.factories import T0, incoming


def authenticate(request: Request, _conn) -> Principal | None:
    """Test-only: the caller says who they are in headers, so sync can be tested without passwords."""
    user = request.headers.get("X-Test-User")
    if user is None:
        return None
    return Principal(
        user_id=user,
        device_id=request.headers.get("X-Test-Device", "phone"),
        active=request.headers.get("X-Test-Active", "yes") == "yes",
        role=request.headers.get("X-Test-Role", "user"),
    )


@pytest.fixture
def client(db_path):
    return TestClient(create_app(db_path, authenticate))


@pytest.fixture
def real(db_path):
    """The real authenticator, with the first Admin already created."""
    with open_db(db_path) as conn:
        accounts.create_admin(conn, "Alex", "alex@example.org", "correct horse")
    return TestClient(create_app(db_path))


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
    assert {"/sync/bootstrap", "/sync/push", "/sync/pull", "/auth/sign-in", "/users/invite"} <= set(paths)


# --- accounts, over HTTP with real tokens ---------------------------------------------------


def sign_in(client, email="alex@example.org", password="correct horse", device="phone-a"):
    r = client.post("/auth/sign-in", json={"email": email, "password": password, "device_id": device})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_sign_in_then_sync_with_a_bearer_token(real):
    auth = sign_in(real)
    assert real.get("/sync/bootstrap", headers=auth).status_code == 200
    assert real.get("/sync/bootstrap").status_code == 401
    assert real.get("/sync/bootstrap", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert real.get("/sync/bootstrap", headers={"Authorization": "Basic abc"}).status_code == 401


def test_wrong_password_is_401_with_no_hint(real):
    r = real.post("/auth/sign-in", json={"email": "alex@example.org", "password": "nope", "device_id": "p"})
    assert r.status_code == 401
    assert r.json()["message"] == "wrong email or password"


def test_sign_in_body_is_validated(real):
    r = real.post("/auth/sign-in", json={"email": "not-an-email", "password": "x", "device_id": "p"})
    assert r.status_code == 400
    assert r.json()["message"].startswith("email:")


def test_invite_redeem_and_manage(real):
    admin = sign_in(real)

    invited = real.post("/users/invite", json={"name": "Bea", "email": "bea@example.org"}, headers=admin)
    assert invited.status_code == 200, invited.text
    user_id, token = invited.json()["user_id"], invited.json()["token"]

    joined = real.post("/auth/redeem", json={"token": token, "password": "battery staple", "device_id": "phone-b"})
    assert joined.status_code == 200, joined.text
    bea = {"Authorization": f"Bearer {joined.json()['token']}"}
    assert joined.json()["user"]["role"] == "user"

    # Bea can sync but not manage users.
    assert real.get("/sync/pull?since=0", headers=bea).status_code == 200
    assert real.get("/users", headers=bea).status_code == 403

    promoted = real.post(f"/users/{user_id}/role", json={"role": "admin"}, headers=admin)
    assert promoted.json()["user"]["role"] == "admin"
    assert real.get("/users", headers=bea).status_code == 200

    # Now Alex can step down, and the last-Admin rule protects Bea.
    alex_id = real.get("/users", headers=admin).json()["users"][0]["id"]
    assert real.post(f"/users/{alex_id}/role", json={"role": "user"}, headers=bea).status_code == 200
    r = real.post(f"/users/{user_id}/deactivate", headers=bea)
    assert r.status_code == 409
    assert r.json()["message"] == "this is the last Admin"


def test_deactivated_over_http(real):
    admin = sign_in(real)
    invited = real.post("/users/invite", json={"name": "Bea", "email": "bea@example.org"}, headers=admin).json()
    bea_token = real.post(
        "/auth/redeem", json={"token": invited["token"], "password": "battery staple", "device_id": "phone-b"}
    ).json()["token"]
    bea = {"Authorization": f"Bearer {bea_token}"}

    assert real.post(f"/users/{invited['user_id']}/deactivate", headers=admin).status_code == 200

    assert real.get("/sync/pull?since=0", headers=bea).json()["error"] == "deactivated"

    push = real.post("/sync/push", json={"device_id": "phone-b", "client_time": T0, "events": []}, headers=bea)
    assert push.status_code == 200, "the final push is accepted (FR-OFF-06)"
    again = real.post("/sync/push", json={"device_id": "phone-b", "client_time": T0, "events": []}, headers=bea)
    assert again.status_code == 401, "and it was the last thing that session could do"
    r = real.post("/auth/sign-in", json={"email": "bea@example.org", "password": "battery staple", "device_id": "p"})
    assert r.status_code == 403


def test_sign_out(real):
    auth = sign_in(real)
    assert real.post("/auth/sign-out", headers=auth).status_code == 200
    assert real.get("/sync/bootstrap", headers=auth).status_code == 401


def test_reset_link_over_http(real):
    admin = sign_in(real)
    alex_id = real.get("/users", headers=admin).json()["users"][0]["id"]
    token = real.post(f"/users/{alex_id}/reset-link", headers=admin).json()["token"]
    r = real.post("/auth/redeem", json={"token": token, "password": "a new password", "device_id": "phone-z"})
    assert r.status_code == 200
    assert real.get("/sync/bootstrap", headers=admin).status_code == 401, "old sessions are revoked by a reset"
    sign_in(real, password="a new password")
