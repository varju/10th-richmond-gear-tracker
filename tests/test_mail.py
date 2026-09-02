"""Mail, against a real SMTP server listening on localhost."""

from __future__ import annotations

import email
import socket

import pytest
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult, LoginPassword
from fastapi.testclient import TestClient

from gear_tracker import accounts, mail
from gear_tracker.app import create_app
from gear_tracker.db import open_db
from gear_tracker.errors import BadRequest, Conflict
from tests.test_app import sign_in

PASSWORD = "app-password"


class Mailbox:
    """Every message the server accepted, parsed."""

    def __init__(self) -> None:
        self.messages: list[email.message.Message] = []

    async def handle_DATA(self, _server, _session, envelope) -> str:  # noqa: N802 (aiosmtpd's name)
        self.messages.append(email.message_from_bytes(envelope.content))
        return "250 OK"

    def only(self) -> email.message.Message:
        assert len(self.messages) == 1, self.messages
        return self.messages[0]

    def body(self) -> str:
        """Decoded: a long link is soft-wrapped on the wire, and would not match otherwise."""
        return self.only().get_payload(decode=True).decode()


def authenticator(_server, _session, _envelope, _mechanism, auth_data):
    ok = isinstance(auth_data, LoginPassword) and auth_data.password == PASSWORD.encode()
    # handled=False both ways: it tells aiosmtpd to send the reply itself. Left
    # to the default the server says nothing and the client waits for a timeout.
    return AuthResult(success=ok, handled=False)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def smtp():
    """A real SMTP server. Plain, since TLS on localhost tests the certificate store, not us."""
    box = Mailbox()
    controller = Controller(
        box,
        hostname="127.0.0.1",
        port=free_port(),
        authenticator=authenticator,
        auth_require_tls=False,
    )
    controller.start()
    box.port = controller.port
    try:
        yield box
    finally:
        controller.stop()


def settings(smtp, **overrides) -> mail.MailSettings:
    return mail.MailSettings(
        **{
            "host": "127.0.0.1",
            "port": smtp.port,
            "encryption": "none",
            "from_address": "gear@example.org",
            **overrides,
        }
    )


def test_a_saved_account_sends(db, smtp):
    mail.save(db, settings(smtp))
    mail.send(db, "bea@example.org", "Subject line", "Body line\n")

    message = smtp.only()
    assert message["From"] == "gear@example.org"
    assert message["To"] == "bea@example.org"
    assert message["Subject"] == "Subject line"
    assert "Body line" in smtp.body()


def test_it_logs_in_when_a_username_is_set(db, smtp):
    mail.save(db, settings(smtp, username="gear@example.org", password=PASSWORD))
    mail.send(db, "bea@example.org", "Hello", "Hello\n")
    assert len(smtp.messages) == 1


def test_a_wrong_password_is_a_bad_request(db, smtp):
    mail.save(db, settings(smtp, username="gear@example.org", password="wrong"))
    with pytest.raises(BadRequest):
        mail.send(db, "bea@example.org", "Hello", "Hello\n")
    assert smtp.messages == []


def test_nothing_is_sent_until_an_account_is_set_up(db):
    assert mail.configured(db) is False
    assert mail.describe(db) is None
    with pytest.raises(Conflict):
        mail.send(db, "bea@example.org", "Hello", "Hello\n")


def test_the_password_is_kept_but_never_read_back(db, smtp):
    mail.save(db, settings(smtp, username="gear@example.org", password=PASSWORD))
    described = mail.describe(db)
    assert "password" not in described
    assert described["has_password"] is True

    # A blank password on a later save means "leave it alone", so an Admin can
    # change the port without retyping a secret they cannot read.
    mail.save(db, settings(smtp, username="gear@example.org"))
    assert mail.get(db)["password"] == PASSWORD
    mail.send(db, "bea@example.org", "Hello", "Hello\n")
    assert len(smtp.messages) == 1


def test_forgetting_the_account_stops_sending(db, smtp):
    mail.save(db, settings(smtp))
    mail.forget(db)
    assert mail.configured(db) is False


@pytest.fixture
def admin_client(db_path):
    with open_db(db_path) as conn:
        accounts.create_admin(conn, "Alex", "alex@example.org", "correct horse")
    return TestClient(create_app(db_path))


def set_up_mail(client, auth, smtp, **overrides):
    r = client.put("/mail", json=settings(smtp, **overrides).model_dump(), headers=auth)
    assert r.status_code == 200, r.text
    return r.json()["mail"]


def test_an_admin_sets_up_mail_and_sends_a_test(admin_client, smtp):
    auth = sign_in(admin_client)
    assert admin_client.get("/mail", headers=auth).json()["mail"] is None

    described = set_up_mail(admin_client, auth, smtp, username="gear@example.org", password=PASSWORD)
    assert described == {
        "host": "127.0.0.1",
        "port": smtp.port,
        "encryption": "none",
        "username": "gear@example.org",
        "from_address": "gear@example.org",
        "has_password": True,
    }

    r = admin_client.post("/mail/test", headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["sent_to"] == "alex@example.org"
    assert smtp.only()["To"] == "alex@example.org"

    assert admin_client.delete("/mail", headers=auth).json()["mail"] is None
    assert admin_client.get("/mail", headers=auth).json()["mail"] is None


def test_mail_settings_are_admin_only(admin_client, smtp):
    admin = sign_in(admin_client)
    set_up_mail(admin_client, admin, smtp)
    invited = admin_client.post("/users/invite", json={"name": "Bea", "email": "bea@example.org"}, headers=admin).json()
    bea = admin_client.post(
        "/auth/redeem", json={"token": invited["token"], "password": "battery staple", "device_id": "phone-b"}
    ).json()
    auth = {"Authorization": f"Bearer {bea['token']}"}

    assert admin_client.get("/mail", headers=auth).status_code == 403
    assert admin_client.put("/mail", json=settings(smtp).model_dump(), headers=auth).status_code == 403
    assert admin_client.post("/mail/test", headers=auth).status_code == 403
    assert admin_client.delete("/mail", headers=auth).status_code == 403


def test_an_invite_is_mailed_when_a_link_is_given(admin_client, smtp):
    auth = sign_in(admin_client)
    set_up_mail(admin_client, auth, smtp)

    r = admin_client.post(
        "/users/invite",
        json={"name": "Bea", "email": "bea@example.org", "link": "https://example.org/gear/join?t=TOKEN"},
        headers=auth,
    )
    body = r.json()
    assert body["emailed"] is True
    assert smtp.only()["To"] == "bea@example.org"
    assert f"https://example.org/gear/join?t={body['token']}" in smtp.body()


def test_a_reset_link_is_mailed_when_a_link_is_given(admin_client, smtp):
    auth = sign_in(admin_client)
    set_up_mail(admin_client, auth, smtp)
    alex_id = admin_client.get("/users", headers=auth).json()["users"][0]["id"]

    body = admin_client.post(
        f"/users/{alex_id}/reset-link", json={"link": "https://example.org/gear/join?t=TOKEN"}, headers=auth
    ).json()
    assert body["emailed"] is True
    assert smtp.only()["To"] == "alex@example.org"
    assert f"t={body['token']}" in smtp.body()


def test_a_broken_mail_account_still_hands_back_the_link(admin_client, smtp):
    auth = sign_in(admin_client)
    set_up_mail(admin_client, auth, smtp, username="gear@example.org", password="wrong")

    body = admin_client.post(
        "/users/invite",
        json={"name": "Bea", "email": "bea@example.org", "link": "https://example.org/gear/join?t=TOKEN"},
        headers=auth,
    ).json()
    assert body["emailed"] is False
    assert "mail_error" in body
    assert body["token"], "the invite still worked; the Admin copies the link"


def test_no_mail_account_means_no_mail_and_no_error(admin_client):
    auth = sign_in(admin_client)
    body = admin_client.post(
        "/users/invite",
        json={"name": "Bea", "email": "bea@example.org", "link": "https://example.org/gear/join?t=TOKEN"},
        headers=auth,
    ).json()
    assert body["emailed"] is False
    assert "mail_error" not in body
    assert body["token"]
