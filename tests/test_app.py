"""The three routes, over real HTTP semantics, against a real SQLite file."""

from __future__ import annotations

import json

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from gear_tracker import accounts, derived, events, inventory_csv
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


def test_every_route_but_the_public_one_needs_a_principal(client):
    assert client.get("/sync/bootstrap").status_code == 401
    assert client.get("/sync/pull?since=0").status_code == 401
    assert client.post("/sync/push", json={}).status_code == 401

    assert client.get("/codes/AAAAAAAAAA").status_code == 401
    assert client.get("/public/codes/AAAAAAAAAA").status_code == 404  # signed out, and looked it up anyway

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


def test_history_is_the_whole_record_in_replay_order(client):
    """The server keeps everything; a device keeps 90 days (FR-INV-31)."""
    old = event(id="01AAAAAAAAAAAAAAAAAAAAAAAA", type="created", payload={"name": "Tent"}, occurred_at=T0, device_seq=1)
    new = event(id="01BBBBBBBBBBBBBBBBBBBBBBBB", occurred_at=T0 + 60_000, device_seq=2)
    other = event(entity_id="tarp-1", type="created", payload={"name": "Tarp"}, device_seq=3)
    assert client.post("/sync/push", json=push_body(old, new, other), headers=as_alice()).status_code == 200

    r = client.get("/history/item/tent-1", headers=as_alice())
    assert r.status_code == 200
    assert [e["id"] for e in r.json()["events"]] == [old["id"], new["id"]]
    assert "server_time" in r.json()

    # The same shape pull sends, so one renderer draws both.
    pulled = client.get("/sync/pull?since=0", headers=as_alice()).json()["events"]
    assert r.json()["events"][0] == next(e for e in pulled if e["id"] == old["id"])


def test_history_of_a_kind_is_every_event_of_it(client):
    """The repair report reads its whole record at once, not one ticket at a time."""
    ticket = {"item_id": "tent-1", "description": "torn fly"}
    one = event(entity_type="repair", entity_id="t-1", type="created", payload=ticket, device_seq=1)
    two = event(entity_type="repair", entity_id="t-2", type="created", payload=ticket, device_seq=2)
    item = event(type="created", payload={"name": "Tent"}, device_seq=3)
    assert client.post("/sync/push", json=push_body(one, two, item), headers=as_alice()).status_code == 200

    r = client.get("/history/repair", headers=as_alice())
    assert {e["id"] for e in r.json()["events"]} == {one["id"], two["id"]}


def test_history_of_something_that_never_existed_is_empty_not_404(client):
    r = client.get("/history/item/no-such-thing", headers=as_alice())
    assert r.status_code == 200
    assert r.json()["events"] == []


def test_history_needs_a_signed_in_caller_and_a_real_entity_type(client):
    assert client.get("/history/item/tent-1").status_code == 401
    assert client.get("/history/item").status_code == 401
    r = client.get("/history/banana/tent-1", headers=as_alice())
    assert r.status_code == 400
    assert "entity_type must be one of" in r.json()["message"]


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


def test_a_cursor_from_another_log_is_410(client):
    """A device whose snapshot came from a database that has since been replaced."""
    mine = client.get("/sync/bootstrap", headers=as_alice()).json()["log_id"]

    r = client.get("/sync/pull?since=0&log=somewhere-else", headers=as_alice())
    assert r.status_code == 410
    assert r.json()["error"] == "re-bootstrap"
    assert client.get(f"/sync/pull?since=0&log={mine}", headers=as_alice()).status_code == 200


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


def test_revoke_one_device_over_http(real):
    admin = sign_in(real)
    invited = real.post("/users/invite", json={"name": "Bea", "email": "bea@example.org"}, headers=admin).json()
    lost = real.post(
        "/auth/redeem", json={"token": invited["token"], "password": "battery staple", "device_id": "phone-lost"}
    )
    lost_auth = {"Authorization": f"Bearer {lost.json()['token']}"}
    assert real.get("/sync/pull?since=0", headers=lost_auth).status_code == 200

    devices = real.get(f"/users/{invited['user_id']}/devices", headers=admin).json()["devices"]
    assert [d["device_id"] for d in devices] == ["phone-lost"]

    r = real.post(f"/users/{invited['user_id']}/devices/phone-lost/revoke", headers=admin)
    assert r.status_code == 200, r.text
    assert r.json()["devices"] == []
    assert real.get("/sync/pull?since=0", headers=lost_auth).status_code == 401
    # The account is fine: another phone signs in.
    sign_in(real, email="bea@example.org", password="battery staple", device="phone-new")

    alex_id = real.get("/users", headers=admin).json()["users"][0]["id"]
    r = real.post(f"/users/{alex_id}/devices/phone-a/revoke", headers=admin)
    assert r.status_code == 409
    assert r.json()["message"] == "sign out instead"


def test_a_user_sees_and_manages_their_own_devices_over_http(real):
    admin = sign_in(real)
    invited = real.post("/users/invite", json={"name": "Bea", "email": "bea@example.org"}, headers=admin).json()
    joined = real.post(
        "/auth/redeem", json={"token": invited["token"], "password": "battery staple", "device_id": "phone-b"}
    ).json()
    bea = {"Authorization": f"Bearer {joined['token']}"}

    r = real.get(f"/users/{invited['user_id']}/devices", headers=bea)
    assert r.status_code == 200
    assert [d["device_id"] for d in r.json()["devices"]] == ["phone-b"]

    alex_id = real.get("/users", headers=admin).json()["users"][0]["id"]
    assert real.get(f"/users/{alex_id}/devices", headers=bea).status_code == 403


# --- the built client ------------------------------------------------------------------


@pytest.fixture
def site(db_path, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        "<html><head><title>Gear Tracker</title>"
        '<meta name="apple-mobile-web-app-title" content="Gear" /></head>'
        "<body><h1>app</h1></body></html>"
    )
    manifest = {"name": "Gear Tracker", "short_name": "Gear", "display": "standalone"}
    (dist / "manifest.webmanifest").write_text(json.dumps(manifest))
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("no")
    return TestClient(create_app(db_path, authenticate=authenticate, static=dist))


def test_client_files_are_served_and_unknown_paths_fall_back_to_index(site):
    assert "<h1>app</h1>" in site.get("/").text
    assert site.get("/assets/app.js").text == "console.log(1)"
    assert "<h1>app</h1>" in site.get("/some/client/route").text


def test_client_serving_does_not_escape_its_directory(site):
    assert "<h1>app</h1>" in site.get("/../secret.txt").text
    assert "<h1>app</h1>" in site.get("/%2e%2e/secret.txt").text


def test_the_manifest_carries_the_group_name(site, db_path):
    # No group set yet: the build's own names stand.
    r = site.get("/manifest.webmanifest")
    assert r.headers["content-type"] == "application/manifest+json"
    assert r.headers["cache-control"] == "no-cache"
    assert r.json()["name"] == "Gear Tracker"

    with open_db(db_path) as conn:
        events.append_server(conn, "alice", "setting", "group", "created", {"name": "10th Richmond"})

    body = site.get("/manifest.webmanifest").json()
    assert body["name"] == "10th Richmond Gear"
    assert body["short_name"] == "10th Richmond Gear"
    # Everything else the build wrote is untouched.
    assert body["display"] == "standalone"


def test_index_carries_the_group_name(site, db_path):
    # No group set yet: the build's own names stand.
    r = site.get("/")
    assert 'content="Gear"' in r.text
    assert "<title>Gear Tracker</title>" in r.text

    with open_db(db_path) as conn:
        events.append_server(conn, "alice", "setting", "group", "created", {"name": "10th Richmond"})

    for path in ("/", "/some/client/route"):
        r = site.get(path)
        assert r.headers["cache-control"] == "no-cache"
        assert 'content="10th Richmond Gear"' in r.text
        assert "<title>10th Richmond · Gear Tracker</title>" in r.text


def test_api_routes_win_over_the_client(site):
    assert site.get("/sync/bootstrap").status_code == 401
    assert site.get("/sync/pull?since=0", headers={"X-Test-User": "u", "X-Test-Device": "d"}).status_code == 200


# --- codes ------------------------------------------------------------------------------


@pytest.fixture
def admin(db_path):
    """The header authenticator, with an Admin's headers ready to send."""
    return {"X-Test-User": "alice", "X-Test-Device": "phone-a", "X-Test-Role": "admin"}


def test_sheets_are_for_admins(client):
    r = client.post("/codes/sheets", json={"sheets": 1}, headers=as_alice())
    assert r.status_code == 403


def test_sheets_need_the_group_setting(client, admin, db_path):
    r = client.post("/codes/sheets", json={}, headers=admin)
    assert r.status_code == 409
    assert r.json()["message"] == "set the group name, site address and contact in Settings first"

    # Name and URL alone are not enough: a sticker is a public page, and it needs a way back to us.
    with open_db(db_path) as conn:
        events.append_server(
            conn, "alice", "setting", "group", "created", {"name": "10th Richmond", "code_url": "https://example.org"}
        )
    assert client.post("/codes/sheets", json={}, headers=admin).status_code == 409


def test_sheets_body_is_validated(client, admin):
    assert client.post("/codes/sheets", json={"sheets": 0}, headers=admin).status_code == 400
    assert client.post("/codes/sheets", json={"sheets": 11}, headers=admin).status_code == 400
    assert client.post("/codes/sheets", json={"sheets": "1"}, headers=admin).status_code == 400


def test_a_sheet_of_codes(client, admin, db_path):
    with open_db(db_path) as conn:
        events.append_server(
            conn,
            "alice",
            "setting",
            "group",
            "created",
            {"name": "10th Richmond", "code_url": "https://example.org", "contact": "gear@example.org"},
        )

    r = client.post("/codes/sheets", json={}, headers=admin)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"] == 'attachment; filename="codes.pdf"'
    assert r.content.startswith(b"%PDF")

    with open_db(db_path) as conn:
        made = derived.snapshot(conn)["code"]
        actors = {row[0] for row in conn.execute("SELECT actor_id FROM events WHERE entity_type = 'code'")}
    assert len(made) == 32
    assert actors == {"alice"}
    code = next(iter(made))

    found = client.get(f"/codes/{code}", headers=as_alice())
    assert found.status_code == 200
    assert found.json()["code"] == code
    assert found.json()["item_id"] is None
    assert "server_time" in found.json()


def test_looking_up_a_code(client):
    assert client.get("/codes/ABCDEFGH23").status_code == 401
    assert client.get("/codes/not-a-code", headers=as_alice()).status_code == 400
    assert client.get("/codes/ABCDEFGH23", headers=as_alice()).status_code == 404


def test_releasing_a_code_makes_it_unassigned_and_reusable(client, db_path):
    """FR-TAG-14: scanning it again after a release finds it unassigned, and it can go on something else."""
    with open_db(db_path) as conn:
        events.append_server(conn, "alice", "code", "ABCDEFGH23", "created", {})
    client.post(
        "/sync/push",
        json=push_body(
            event(entity_type="item", entity_id="item-1", type="created", payload={"name": "Tent"}),
            event(entity_type="item", entity_id="item-2", type="created", payload={"name": "Tarp"}, device_seq=2),
            event(
                entity_type="code",
                entity_id="ABCDEFGH23",
                type="code_bound",
                payload={"item_id": "item-1"},
                device_seq=3,
            ),
        ),
        headers=as_alice(),
    )
    assert client.get("/codes/ABCDEFGH23", headers=as_alice()).json()["item_id"] == "item-1"

    released = client.post(
        "/sync/push",
        json=push_body(
            event(entity_type="code", entity_id="ABCDEFGH23", type="code_released", payload={}, device_seq=4)
        ),
        headers=as_alice(),
    )
    assert released.json()["accepted"], released.json()
    assert client.get("/codes/ABCDEFGH23", headers=as_alice()).json()["item_id"] is None

    rebound = client.post(
        "/sync/push",
        json=push_body(
            event(
                entity_type="code",
                entity_id="ABCDEFGH23",
                type="code_bound",
                payload={"item_id": "item-2"},
                device_seq=5,
            )
        ),
        headers=as_alice(),
    )
    assert rebound.json()["accepted"], rebound.json()
    assert client.get("/codes/ABCDEFGH23", headers=as_alice()).json()["item_id"] == "item-2"


# --- inventory CSV ------------------------------------------------------------------------


def test_export_is_a_csv_for_any_signed_in_active_person(client):
    client.post("/sync/push", json=push_body(event(type="created", payload={"name": "Tent"})), headers=as_alice())

    r = client.get("/inventory.csv", headers=as_alice())

    assert r.status_code == 200
    assert r.headers["content-type"] == "text/csv; charset=utf-8"
    first_line = r.text.removeprefix("﻿").splitlines()[0]
    assert first_line.split(",") == inventory_csv.COLUMNS


def test_import_routes_are_for_admins(client, admin):
    body = "id,home\r\n"
    assert client.post("/inventory/import/preview", content=body, headers=as_alice()).status_code == 403
    assert client.post("/inventory/import", content=body, headers=as_alice()).status_code == 403
    assert client.post("/inventory/import/preview", content=body, headers=admin).status_code == 200
    assert client.post("/inventory/import", content=body, headers=admin).status_code == 200


def test_an_import_shows_up_in_the_next_bootstrap(client, admin):
    client.post("/sync/push", json=push_body(event(type="created", payload={"name": "Tent"})), headers=as_alice())

    body = "id,description\r\ntent-1,patched fly\r\n"
    r = client.post("/inventory/import", content=body, headers=admin)
    assert r.status_code == 200, r.text
    assert r.json()["changed"] == 1

    booted = client.get("/sync/bootstrap", headers=as_alice()).json()
    assert booted["snapshot"]["item"]["tent-1"]["description"] == "patched fly"


# --- public -----------------------------------------------------------------------------


@pytest.fixture
def public(client, db_path):
    """A tent with a sticker on it, and a group that says how to reach it."""
    with open_db(db_path) as conn:
        events.append_server(
            conn,
            "alice",
            "setting",
            "group",
            "created",
            {"name": "10th Richmond", "code_url": "https://example.org", "contact": "gear@example.org"},
        )
        for code in ("AAAAAAAAAA", "BBBBBBBBBB"):
            events.append_server(conn, "alice", "code", code, "created", {})
    client.post(
        "/sync/push",
        json=push_body(
            event(
                entity_type="item",
                entity_id="item-1",
                type="created",
                payload={"name": "Tent 4", "description": "green, patched fly"},
            ),
            event(
                entity_type="code",
                entity_id="AAAAAAAAAA",
                type="code_bound",
                payload={"item_id": "item-1"},
                device_seq=2,
            ),
        ),
        headers=as_alice(),
    )
    return client


def test_a_stranger_sees_the_item_the_group_and_a_way_to_reach_us(public):
    r = public.get("/public/codes/AAAAAAAAAA")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["item"] == {"name": "Tent 4"}
    assert body["group"] == {"name": "10th Richmond", "contact": "gear@example.org"}


def test_the_public_page_carries_nothing_else(public):
    """Whatever else the item holds stays on our side of the wall (NFR-SEC-03)."""
    r = public.get("/public/codes/AAAAAAAAAA")
    assert set(r.json()) == {"item", "group", "server_time"}
    assert "patched fly" not in r.text


def test_a_printed_but_unbound_code_still_says_whose_it_is(public):
    body = public.get("/public/codes/BBBBBBBBBB").json()
    assert body["item"] is None
    assert body["group"]["name"] == "10th Richmond"


def test_a_released_code_reads_as_unbound_on_the_public_page(public):
    """FR-TAG-14: once the sticker is off the gear, a stranger who scans it sees no item."""
    public.post(
        "/sync/push",
        json=push_body(
            event(entity_type="code", entity_id="AAAAAAAAAA", type="code_released", payload={}, device_seq=3)
        ),
        headers=as_alice(),
    )
    body = public.get("/public/codes/AAAAAAAAAA").json()
    assert body["item"] is None


def test_the_public_route_refuses_a_code_that_is_not_ours(public):
    assert public.get("/public/codes/not-a-code").status_code == 400
    assert public.get("/public/codes/ZZZZZZZZZZ").status_code == 404


def test_a_unit_answers_with_its_generic_name(public):
    """A unit has no name of its own, and the number is no use to a finder (FR-PUB-01, FR-INV-22)."""
    public.post(
        "/sync/push",
        json=push_body(
            event(
                entity_type="item",
                entity_id="tarp",
                type="created",
                payload={"name": "3x3 tarp", "generic": True},
                device_seq=3,
            ),
            event(
                entity_type="item",
                entity_id="tarp-2",
                type="created",
                payload={"parent_id": "tarp", "number": "2", "nickname": "torn corner"},
                device_seq=4,
            ),
            event(
                entity_type="code",
                entity_id="BBBBBBBBBB",
                type="code_bound",
                payload={"item_id": "tarp-2"},
                device_seq=5,
            ),
        ),
        headers=as_alice(),
    )
    r = public.get("/public/codes/BBBBBBBBBB")
    assert r.json()["item"] == {"name": "3x3 tarp"}
    assert "torn corner" not in r.text


# --- found gear ------------------------------------------------------------------------------


def report(public, code="AAAAAAAAAA", address="203.0.113.1", **body):
    return public.post(
        f"/public/codes/{code}/found",
        json={"note": "by the gate at Camp Byng", **body},
        headers={"X-Forwarded-For": address},
    )


def found_reports(public):
    snapshot = public.get("/sync/bootstrap", headers=as_alice()).json()["snapshot"]
    return list(snapshot.get("found_report", {}).values())


def test_a_found_report_lands_on_the_log_under_the_public_actor(public, db_path):
    r = report(public, contact="  finder@example.org ")
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"server_time"}

    [found] = found_reports(public)
    assert found["code"] == "AAAAAAAAAA"
    assert found["item_id"] == "item-1"
    assert found["note"] == "by the gate at Camp Byng"
    assert found["contact"] == "finder@example.org"
    with open_db(db_path) as conn:
        [stored] = [e for e in events.in_replay_order(conn) if e.entity_type == "found_report"]
    assert stored.actor_id == "public"
    assert stored.device_id == "server"


def test_a_report_on_a_sticker_not_yet_on_anything_has_no_item(public):
    assert report(public, code="BBBBBBBBBB").status_code == 200
    [found] = found_reports(public)
    assert found["item_id"] is None


def test_a_report_needs_one_of_our_codes_and_a_note(public):
    assert report(public, code="not-a-code").status_code == 400
    assert report(public, code="ZZZZZZZZZZ").status_code == 404
    r = report(public, note="   ")
    assert r.status_code == 400
    assert r.json()["message"].startswith("note:")
    assert found_reports(public) == []


def test_a_filled_honeypot_is_thanked_and_dropped(public):
    assert report(public, website="http://spam.example").status_code == 200
    assert found_reports(public) == []


def test_one_address_gets_five_an_hour(public):
    for n in range(5):
        assert report(public, code="BBBBBBBBBB" if n % 2 else "AAAAAAAAAA").status_code == 200, n
    refused = report(public)
    assert refused.status_code == 429
    assert refused.json()["error"] == "rate_limited"
    assert refused.json()["message"] == "too many reports; try again later"
    # Someone else behind the same proxy is not the same someone.
    assert report(public, code="BBBBBBBBBB", address="198.51.100.7").status_code == 200
    assert len(found_reports(public)) == 6


def test_one_sticker_gets_three_a_day(public):
    for n in range(3):
        assert report(public, address=f"203.0.113.{n}").status_code == 200
    assert report(public, address="203.0.113.9").status_code == 429
    assert report(public, code="BBBBBBBBBB", address="203.0.113.9").status_code == 200
