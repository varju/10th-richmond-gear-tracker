"""Photos: files beside the database, recorded on the log by the server (FR-INV-11, FR-REP-01)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from gear_tracker.app import PHOTO_MAX_BYTES, create_app
from gear_tracker.db import open_db
from gear_tracker.events import append
from tests.factories import T0, incoming
from tests.test_app import as_alice, authenticate

PHOTO = "01000000000000000000000AAA"
JPEG = b"\xff\xd8\xff\xe0 not really a jpeg"


def seed(db_path):
    with open_db(db_path) as conn:
        append(conn, incoming(type="created", payload={"name": "Tent"}), received_at=T0)
        ticket = {"item_id": "tent-1", "description": "pole bent"}
        append(
            conn,
            incoming(device_seq=2, entity_type="repair", entity_id="rep-1", type="created", payload=ticket),
            received_at=T0,
        )


@pytest.fixture
def client(db_path):
    seed(db_path)
    return TestClient(create_app(db_path, authenticate))


def put(client, photo_id=PHOTO, entity="item/tent-1", body=JPEG, content_type="image/jpeg", **headers):
    entity_type, entity_id = entity.split("/")
    return client.put(
        f"/photos/{photo_id}?entity_type={entity_type}&entity_id={entity_id}",
        content=body,
        headers=as_alice(**{"Content-Type": content_type, **headers}),
    )


def photos_of(client, entity_type, entity_id):
    booted = client.get("/sync/bootstrap", headers=as_alice()).json()
    return booted["snapshot"][entity_type][entity_id].get("photos", [])


def test_the_default_store_is_beside_the_database(db_path, client):
    assert put(client).status_code == 200
    assert (db_path.parent / "photos" / f"{PHOTO}.jpg").read_bytes() == JPEG


def test_an_upload_is_recorded_on_the_entity_and_served_back(client):
    put(client)
    [photo] = photos_of(client, "item", "tent-1")
    assert photo == {
        "id": PHOTO,
        "content_type": "image/jpeg",
        "size": len(JPEG),
        "actor_id": "alice",
        "at": photo["at"],
    }

    got = client.get(f"/photos/{PHOTO}", headers=as_alice())
    assert got.status_code == 200
    assert got.content == JPEG
    assert got.headers["Content-Type"] == "image/jpeg"
    assert got.headers["Cache-Control"] == "no-store"


def test_a_ticket_takes_a_photo_too(client):
    assert put(client, entity="repair/rep-1", content_type="image/png").status_code == 200
    assert photos_of(client, "repair", "rep-1")[0]["content_type"] == "image/png"


def test_a_retry_writes_nothing_twice(client, db_path):
    put(client)
    assert put(client, body=b"different bytes").status_code == 200
    assert (db_path.parent / "photos" / f"{PHOTO}.jpg").read_bytes() == JPEG
    assert len(photos_of(client, "item", "tent-1")) == 1


def test_what_is_refused(client):
    assert client.put(f"/photos/{PHOTO}?entity_type=item&entity_id=tent-1", content=JPEG).status_code == 401
    assert put(client, photo_id="not-a-ulid").status_code == 400
    assert put(client, entity="location/loc-1").status_code == 400
    assert put(client, entity="item/nope").status_code == 404
    assert put(client, content_type="image/gif").json()["message"].startswith("Content-Type must be one of")
    assert put(client, body=b"").json()["message"] == "the photo is empty"
    big = put(client, body=b"x" * (PHOTO_MAX_BYTES + 1))
    assert big.status_code == 413
    assert big.json()["error"] == "too_large"
    assert put(client, **{"X-Test-Active": "no"}).status_code == 403
    assert client.get(f"/photos/{PHOTO}", headers=as_alice()).status_code == 404
    assert client.get(f"/photos/{PHOTO}").status_code == 401


def test_the_store_can_be_placed_elsewhere(db_path, tmp_path):
    elsewhere = tmp_path / "somewhere" / "else"
    seed(db_path)
    client = TestClient(create_app(db_path, authenticate, photos=elsewhere))
    assert put(client).status_code == 200
    assert (elsewhere / f"{PHOTO}.jpg").is_file()
    assert not (db_path.parent / "photos").exists()
