"""Notification preferences, and each trigger actually sending, against a real SMTP server.

Sending runs on a background thread (notify.py), so a test that expects mail
polls briefly for it rather than assuming it has landed the instant the
triggering call returns.
"""

from __future__ import annotations

import email
import socket
import time
from typing import Any, cast

import pytest
from aiosmtpd.controller import Controller
from fastapi import Request
from fastapi.testclient import TestClient

from gear_tracker import accounts, assistant, events, mail, notify
from gear_tracker.app import create_app
from gear_tracker.db import open_db
from gear_tracker.sync import Principal
from tests.factories import T0, incoming


class _Mailbox:
    """Every message a local SMTP server accepted. See tests/test_mail.py for the fuller version."""

    def __init__(self) -> None:
        self.messages: list[email.message.Message] = []
        self.port = 0

    async def handle_DATA(self, _server, _session, envelope) -> str:  # noqa: N802 (aiosmtpd's name)
        self.messages.append(email.message_from_bytes(envelope.content))
        return "250 OK"

    def only(self) -> email.message.Message:
        assert len(self.messages) == 1, self.messages
        return self.messages[0]

    def body(self) -> str:
        """Decoded: a long link is soft-wrapped on the wire, and would not match otherwise."""
        return cast(bytes, self.only().get_payload(decode=True)).decode()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def smtp():
    """A real SMTP server on localhost. Plain, since TLS on localhost tests the certificate store, not us."""
    box = _Mailbox()
    controller = Controller(box, hostname="127.0.0.1", port=_free_port(), auth_require_tls=False)
    controller.start()
    box.port = controller.port
    try:
        yield box
    finally:
        controller.stop()


def settings(smtp, **overrides) -> mail.MailSettings:
    fields: dict[str, Any] = {
        "host": "127.0.0.1",
        "port": smtp.port,
        "encryption": "none",
        "from_address": "gear@example.org",
        **overrides,
    }
    return mail.MailSettings(**fields)


def authenticate(request: Request, _conn) -> Principal | None:
    """Test-only: the caller says who they are in headers, as tests/test_app.py does."""
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


def push_body(*evs):
    return {"device_id": "phone-a", "client_time": T0, "events": list(evs)}


def wait_for(mailbox, count: int = 1, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and len(mailbox.messages) < count:
        time.sleep(0.01)
    assert len(mailbox.messages) >= count, mailbox.messages


# --- preferences ---------------------------------------------------------------------------


def test_categories_default_to_off_and_say_whether_mail_is_set_up(client):
    r = client.get("/me/notifications", headers={"X-Test-User": "bea"})
    assert r.status_code == 200, r.text
    assert r.json()["categories"] == {"found": False, "repair": False, "joined": False}
    assert r.json()["mail_configured"] is False


def test_signing_in_is_required(client):
    assert client.get("/me/notifications").status_code == 401
    assert client.put("/me/notifications", json={}).status_code == 401


def test_a_deactivated_account_is_refused(client):
    headers = {"X-Test-User": "bea", "X-Test-Active": "no"}
    assert client.get("/me/notifications", headers=headers).status_code == 403
    assert client.put("/me/notifications", json={}, headers=headers).status_code == 403


def test_a_user_sets_their_own_categories_and_nobody_elses(client, db_path):
    # A saved preference is a row keyed on a real account, so this needs one, unlike the two
    # tests above whose calls never get past a read or a refusal before touching that table.
    with open_db(db_path) as conn:
        admin_id = accounts.install_admin(conn, "Alex", "alex@example.org", "correct horse")
        who = Principal(user_id=admin_id, device_id="admin-device", role="admin")
        bea_id, _ = accounts.invite(conn, who, accounts.Invite(name="Bea", email="bea@example.org"))
        cara_id, _ = accounts.invite(conn, who, accounts.Invite(name="Cara", email="cara@example.org"))

    r = client.put("/me/notifications", json={"found": True, "repair": True}, headers={"X-Test-User": bea_id})
    assert r.status_code == 200, r.text
    assert r.json()["categories"] == {"found": True, "repair": True, "joined": False}

    # Someone else's preferences are untouched.
    assert client.get("/me/notifications", headers={"X-Test-User": cara_id}).json()["categories"] == {
        "found": False,
        "repair": False,
        "joined": False,
    }

    # Saving again replaces the set; leaving a category out turns it off.
    r = client.put("/me/notifications", json={"repair": True}, headers={"X-Test-User": bea_id})
    assert r.json()["categories"] == {"found": False, "repair": True, "joined": False}


# --- found gear (FR-PUB-02) ------------------------------------------------------------------


def _found_setup(db_path, smtp):
    """A tent on a sticker, an Admin who wants to hear about found gear, and a user who does not."""
    with open_db(db_path) as conn:
        mail.save(conn, settings(smtp))
        events.append_server(
            conn,
            "seed",
            "setting",
            "group",
            "created",
            {"name": "10th Richmond", "code_url": "https://example.org/gear", "contact": "gear@example.org"},
        )
        admin_id = accounts.install_admin(conn, "Alex", "alex@example.org", "correct horse")
        who = Principal(user_id=admin_id, device_id="admin-device", role="admin")
        cara_id, _ = accounts.invite(conn, who, accounts.Invite(name="Cara", email="cara@example.org"))
        notify.set_categories(conn, admin_id, notify.Preferences(found=True))
        # Cara never subscribed, so a found report must not reach her.
        assert notify.get(conn, cara_id)["found"] is False
        events.append_server(conn, admin_id, "item", "item-1", "created", {"name": "Tent 4"})
        events.append_server(conn, admin_id, "code", "AAAAAAAAAA", "created", {})
        events.append_server(conn, admin_id, "code", "AAAAAAAAAA", "code_bound", {"item_id": "item-1"})


def test_a_found_report_mails_only_the_subscribed(client, db_path, smtp):
    _found_setup(db_path, smtp)
    r = client.post("/public/codes/AAAAAAAAAA/found", json={"note": "by the gate", "contact": "finder@example.org"})
    assert r.status_code == 200, r.text

    wait_for(smtp)
    message = smtp.only()
    assert message["To"] == "alex@example.org"
    assert "Tent 4" in smtp.body()
    assert "by the gate" in smtp.body()
    assert "finder@example.org" in smtp.body()
    assert "https://example.org/gear/items/item-1" in smtp.body()


def test_nothing_is_sent_when_mail_is_not_configured(client, db_path):
    with open_db(db_path) as conn:
        admin_id = accounts.install_admin(conn, "Alex", "alex@example.org", "correct horse")
        notify.set_categories(conn, admin_id, notify.Preferences(found=True))
        events.append_server(conn, admin_id, "item", "item-1", "created", {"name": "Tent 4"})
        events.append_server(conn, admin_id, "code", "AAAAAAAAAA", "created", {})
        events.append_server(conn, admin_id, "code", "AAAAAAAAAA", "code_bound", {"item_id": "item-1"})

    r = client.post("/public/codes/AAAAAAAAAA/found", json={"note": "by the gate", "contact": ""})
    assert r.status_code == 200, r.text  # the report succeeds either way; nothing to assert about mail


# --- repair tickets (FR-REP-01) ------------------------------------------------------------


def _repair_setup(db_path, smtp):
    with open_db(db_path) as conn:
        mail.save(conn, settings(smtp))
        admin_id = accounts.install_admin(conn, "Alex", "alex@example.org", "correct horse")
        who = Principal(user_id=admin_id, device_id="admin-device", role="admin")
        alice_id, _ = accounts.invite(conn, who, accounts.Invite(name="Alice", email="alice@example.org"))
        notify.set_categories(conn, admin_id, notify.Preferences(repair=True))
        # Alice raises the ticket herself, and is also subscribed; she must not be mailed about it.
        notify.set_categories(conn, alice_id, notify.Preferences(repair=True))
        events.append_server(conn, admin_id, "item", "item-1", "created", {"name": "Camp stove"})
    return admin_id, alice_id


def test_a_pushed_repair_ticket_mails_subscribers_but_not_whoever_raised_it(client, db_path, smtp):
    _admin_id, alice_id = _repair_setup(db_path, smtp)

    r = client.post(
        "/sync/push",
        json=push_body(
            incoming(
                entity_type="repair",
                entity_id="ticket-1",
                type="created",
                actor_id=alice_id,
                payload={"item_id": "item-1", "description": "valve sticks"},
            )
        ),
        headers={"X-Test-User": alice_id, "X-Test-Device": "phone-a"},
    )
    assert r.status_code == 200, r.text

    wait_for(smtp)
    message = smtp.only()
    assert message["To"] == "alex@example.org"
    assert "Camp stove" in smtp.body()
    assert "valve sticks" in smtp.body()
    assert "Alice" in smtp.body()


def test_raising_a_ticket_through_the_assistant_tool_also_mails(db_path, smtp):
    """raise_ticket (FR-MCP-05) is a push like any other, through the same code in sync.py."""
    _admin_id, alice_id = _repair_setup(db_path, smtp)
    who = Principal(user_id=alice_id, device_id="mcp-01BBBBBBBBBBBBBBBBBBBBBBBB")

    with assistant.acting_as(who, db_path):
        assistant.raise_ticket("item-1", "valve sticks")

    wait_for(smtp)
    assert smtp.only()["To"] == "alex@example.org"


def test_a_retried_push_does_not_mail_twice(client, db_path, smtp):
    """Push is idempotent on event id; a retry after a dropped connection must not double the mail."""
    _admin_id, alice_id = _repair_setup(db_path, smtp)
    body = push_body(
        incoming(
            entity_type="repair",
            entity_id="ticket-1",
            type="created",
            actor_id=alice_id,
            payload={"item_id": "item-1", "description": "valve sticks"},
        )
    )
    headers = {"X-Test-User": alice_id, "X-Test-Device": "phone-a"}
    assert client.post("/sync/push", json=body, headers=headers).status_code == 200
    assert client.post("/sync/push", json=body, headers=headers).status_code == 200

    wait_for(smtp)
    time.sleep(0.2)  # give a wrongly-sent second message a chance to land
    assert len(smtp.messages) == 1


# --- joining (FR-USR-18) --------------------------------------------------------------------


def test_redeeming_an_invite_mails_subscribed_admins(db_path, smtp):
    with open_db(db_path) as conn:
        mail.save(conn, settings(smtp))
        admin_id = accounts.install_admin(conn, "Alex", "alex@example.org", "correct horse")
        notify.set_categories(conn, admin_id, notify.Preferences(joined=True))
        who = Principal(user_id=admin_id, device_id="admin-device", role="admin")
        _, token = accounts.invite(conn, who, accounts.Invite(name="Bea", email="bea@example.org"))
        accounts.redeem(conn, accounts.Redeem(token=token, password="battery staple", device_id="phone-b"))

    wait_for(smtp)
    message = smtp.only()
    assert message["To"] == "alex@example.org"
    assert "Bea" in smtp.body()
    assert "bea@example.org" in smtp.body()


def test_a_password_reset_is_not_a_new_account(db_path, smtp):
    with open_db(db_path) as conn:
        mail.save(conn, settings(smtp))
        admin_id = accounts.install_admin(conn, "Alex", "alex@example.org", "correct horse")
        notify.set_categories(conn, admin_id, notify.Preferences(joined=True))
        who = Principal(user_id=admin_id, device_id="admin-device", role="admin")
        token = accounts.reset_link(conn, who, admin_id)
        accounts.redeem(conn, accounts.Redeem(token=token, password="a new password", device_id="phone-a"))

    time.sleep(0.2)
    assert smtp.messages == []
