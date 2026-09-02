"""Accounts against the real database: sign-in, links, roles, and the audit trail they leave."""

from __future__ import annotations

import pytest

from gear_tracker import accounts
from gear_tracker.accounts import Invite, Redeem, SignIn
from gear_tracker.derived import snapshot
from gear_tracker.errors import BadRequest, Conflict, Deactivated, Forbidden, NotFound, Unauthorized
from gear_tracker.events import SERVER_DEVICE, in_replay_order
from gear_tracker.sync import Principal, pull, push
from tests.factories import T0, incoming

DAY = 86_400_000


@pytest.fixture
def admin(db) -> Principal:
    user_id = accounts.create_admin(db, "Alex", "alex@example.org", "correct horse", now=T0)
    return Principal(user_id=user_id, device_id="server", active=True, role="admin")


def invite(db, admin, name="Bea", email="bea@example.org", role="user", now=T0):
    return accounts.invite(db, admin, Invite(name=name, email=email, role=role), now=now)


def join(db, token, password="battery staple", device="phone-b", now=T0):
    return accounts.redeem(db, Redeem(token=token, password=password, device_id=device), now=now)


# --- the first Admin -----------------------------------------------------------------


def test_the_first_admin_creates_themself_on_the_log(db):
    user_id = accounts.create_admin(db, "Alex", "alex@example.org", "correct horse", now=T0)

    [event] = in_replay_order(db)
    assert event.entity_type == "user"
    assert event.entity_id == user_id
    assert event.actor_id == user_id
    assert event.device_id == SERVER_DEVICE
    assert event.payload == {"name": "Alex", "role": "admin", "active": True}
    assert snapshot(db)["user"][user_id] == {
        "name": "Alex",
        "role": "admin",
        "active": True,
        "added_at": T0,
        "modified_at": T0,
    }


def test_only_one_first_admin(db, admin):
    with pytest.raises(Conflict, match="already exists"):
        accounts.create_admin(db, "Bea", "bea@example.org", "battery staple", now=T0)


def test_the_first_admin_can_sign_in(db, admin):
    session = accounts.sign_in(db, SignIn(email="Alex@Example.org", password="correct horse", device_id="p"), now=T0)
    assert session.user["id"] == admin.user_id
    assert session.user["role"] == "admin"
    assert accounts.authenticate(db, session.token) == Principal(admin.user_id, "p", True, "admin")


# --- invite, redeem, sign in ------------------------------------------------------------


def test_invite_then_redeem_then_sign_in(db, admin):
    user_id, token = invite(db, admin)

    users = accounts.list_users(db)
    bea = next(u for u in users if u["id"] == user_id)
    assert bea == {
        "id": user_id,
        "name": "Bea",
        "role": "user",
        "active": True,
        "email": "bea@example.org",
        "has_password": False,
        "added_at": T0,
        "modified_at": T0,
    }

    session = join(db, token)
    assert session.user["id"] == user_id
    assert accounts.authenticate(db, session.token) == Principal(user_id, "phone-b", True, "user")

    again = accounts.sign_in(db, SignIn(email="bea@example.org", password="battery staple", device_id="tablet"), now=T0)
    assert again.token != session.token
    assert accounts.authenticate(db, again.token).device_id == "tablet"


def test_an_invite_is_an_audited_event_with_the_admin_as_actor(db, admin):
    user_id, _ = invite(db, admin)
    created = [e for e in in_replay_order(db) if e.entity_id == user_id]
    assert [e.type for e in created] == ["created"]
    assert created[0].actor_id == admin.user_id


def test_email_is_not_on_the_log(db, admin):
    user_id, _ = invite(db, admin)
    assert "email" not in snapshot(db)["user"][user_id]
    assert "email" not in " ".join(str(e.payload) for e in in_replay_order(db))


def test_a_link_works_once(db, admin):
    _, token = invite(db, admin)
    join(db, token)
    with pytest.raises(Unauthorized, match="not valid"):
        join(db, token)


def test_a_link_dies_after_a_week(db, admin):
    _, token = invite(db, admin, now=T0)
    with pytest.raises(Unauthorized, match="not valid"):
        join(db, token, now=T0 + accounts.LINK_TTL_MS + 1)


def test_a_made_up_link_is_refused(db, admin):
    with pytest.raises(Unauthorized):
        join(db, "nope")


def test_wrong_password_and_unknown_email_look_the_same(db, admin):
    with pytest.raises(Unauthorized) as wrong:
        accounts.sign_in(db, SignIn(email="alex@example.org", password="nope nope", device_id="p"), now=T0)
    with pytest.raises(Unauthorized) as unknown:
        accounts.sign_in(db, SignIn(email="who@example.org", password="correct horse", device_id="p"), now=T0)
    assert wrong.value.message == unknown.value.message


def test_an_invited_user_without_a_password_cannot_sign_in(db, admin):
    invite(db, admin)
    with pytest.raises(Unauthorized):
        accounts.sign_in(db, SignIn(email="bea@example.org", password="anything!", device_id="p"), now=T0)


def test_duplicate_email_is_refused(db, admin):
    invite(db, admin)
    with pytest.raises(Conflict, match="email"):
        invite(db, admin, name="Bea Two", email="BEA@example.org")


def test_a_device_cannot_call_itself_the_server(db, admin):
    with pytest.raises(BadRequest):
        accounts.sign_in(
            db, SignIn(email="alex@example.org", password="correct horse", device_id=SERVER_DEVICE), now=T0
        )


def test_sign_out_ends_that_session_only(db, admin):
    a = accounts.sign_in(db, SignIn(email="alex@example.org", password="correct horse", device_id="a"), now=T0)
    b = accounts.sign_in(db, SignIn(email="alex@example.org", password="correct horse", device_id="b"), now=T0)

    accounts.sign_out(db, a.token, now=T0)

    assert accounts.authenticate(db, a.token) is None
    assert accounts.authenticate(db, b.token) is not None


def test_a_password_reset_revokes_old_sessions(db, admin):
    user_id, token = invite(db, admin)
    old = join(db, token)
    reset = accounts.reset_link(db, admin, user_id, now=T0)

    new = join(db, reset, password="a new password", device="phone-c")

    assert accounts.authenticate(db, old.token) is None
    assert accounts.authenticate(db, new.token).device_id == "phone-c"
    accounts.sign_in(db, SignIn(email="bea@example.org", password="a new password", device_id="d"), now=T0)


def test_no_reset_link_for_a_deactivated_account(db, admin):
    user_id, _ = invite(db, admin)
    accounts.deactivate(db, admin, user_id, now=T0)
    with pytest.raises(Conflict, match="reactivate"):
        accounts.reset_link(db, admin, user_id, now=T0)


# --- roles and deactivation -------------------------------------------------------------------


def test_role_change_is_an_event_with_old_and_new(db, admin):
    user_id, _ = invite(db, admin)
    accounts.set_role(db, admin, user_id, "admin", now=T0 + 1)

    change = [e for e in in_replay_order(db) if e.entity_id == user_id][-1]
    assert change.type == "field_changed"
    assert change.payload == {"field": "role", "value": "admin", "old": "user"}
    assert change.actor_id == admin.user_id
    assert accounts.get_user(db, user_id)["role"] == "admin"


def test_a_no_op_change_writes_nothing(db, admin):
    user_id, _ = invite(db, admin)
    before = db.execute("SELECT count(*) FROM events").fetchone()[0]
    accounts.set_role(db, admin, user_id, "user", now=T0)
    accounts.reactivate(db, admin, user_id, now=T0)
    assert db.execute("SELECT count(*) FROM events").fetchone()[0] == before


def test_deactivation_ends_access_but_not_history(db, admin):
    """FR-USR-06, NFR-SEC-07."""
    user_id, token = invite(db, admin)
    session = join(db, token)

    accounts.deactivate(db, admin, user_id, now=T0 + 1)

    who = accounts.authenticate(db, session.token)
    assert who is not None and who.active is False, "the session exists, marked inactive, for the final push"
    with pytest.raises(Deactivated):
        accounts.sign_in(db, SignIn(email="bea@example.org", password="battery staple", device_id="p"), now=T0)
    with pytest.raises(Deactivated):
        pull(db, who, cursor=0, now=T0)

    history = [e for e in in_replay_order(db) if e.entity_id == user_id]
    assert [e.type for e in history] == ["created", "field_changed"]
    assert history[-1].payload == {"field": "active", "value": False, "old": True}
    assert snapshot(db)["user"][user_id]["name"] == "Bea"


def test_a_deactivated_users_final_push_still_lands(db, admin):
    """FR-OFF-06 end to end: through a real session."""
    user_id, token = invite(db, admin)
    session = join(db, token, device="phone-b")
    accounts.deactivate(db, admin, user_id, now=T0)

    who = accounts.authenticate(db, session.token)
    event = incoming(actor_id=user_id, device_id="phone-b", type="checked_in", payload={})
    result = push(db, who, {"device_id": "phone-b", "client_time": T0, "events": [event]}, now=T0)

    assert result["accepted"] == [event["id"]]


def test_reactivation_restores_access(db, admin):
    user_id, token = invite(db, admin)
    session = join(db, token)
    accounts.deactivate(db, admin, user_id, now=T0)
    accounts.reactivate(db, admin, user_id, now=T0 + 1)

    assert accounts.authenticate(db, session.token).active is True
    assert accounts.get_user(db, user_id)["active"] is True


def test_the_last_admin_cannot_be_demoted_or_deactivated(db, admin):
    """FR-USR-03."""
    with pytest.raises(Conflict, match="last Admin"):
        accounts.set_role(db, admin, admin.user_id, "user", now=T0)
    with pytest.raises(Conflict, match="last Admin"):
        accounts.deactivate(db, admin, admin.user_id, now=T0)

    # With a second Admin, both are allowed.
    user_id, _ = invite(db, admin)
    accounts.set_role(db, admin, user_id, "admin", now=T0)
    accounts.set_role(db, admin, admin.user_id, "user", now=T0 + 1)
    assert accounts.get_user(db, admin.user_id)["role"] == "user"


def test_a_deactivated_admin_does_not_count(db, admin):
    user_id, _ = invite(db, admin, role="admin")
    accounts.deactivate(db, admin, user_id, now=T0)
    with pytest.raises(Conflict, match="last Admin"):
        accounts.deactivate(db, admin, admin.user_id, now=T0)


def test_users_cannot_manage_users(db, admin):
    user_id, _ = invite(db, admin)
    bea = Principal(user_id=user_id, device_id="phone-b", role="user")
    with pytest.raises(Forbidden):
        invite(db, bea, name="Cal", email="cal@example.org")
    with pytest.raises(Forbidden):
        accounts.set_role(db, bea, user_id, "admin")
    with pytest.raises(Forbidden):
        accounts.deactivate(db, bea, admin.user_id)


def test_a_deactivated_admin_cannot_manage_users(db, admin):
    user_id, _ = invite(db, admin, role="admin")
    accounts.deactivate(db, admin, user_id, now=T0)
    gone = Principal(user_id=user_id, device_id="p", active=False, role="admin")
    with pytest.raises(Deactivated):
        invite(db, gone, name="Cal", email="cal@example.org")


def test_unknown_user(db, admin):
    with pytest.raises(NotFound):
        accounts.set_role(db, admin, "01000000000000000000000000", "admin")


def test_devices_cannot_push_user_changes(db, admin):
    """User changes go through the accounts API so the last-Admin rule and roles hold."""
    bea = Principal(user_id="bea", device_id="phone-b")
    event = incoming(
        actor_id="bea",
        device_id="phone-b",
        entity_type="user",
        entity_id=admin.user_id,
        payload={"field": "role", "value": "user", "old": "admin"},
    )
    result = push(db, bea, {"device_id": "phone-b", "client_time": T0, "events": [event]}, now=T0)
    assert result["rejected"] == [{"id": event["id"], "reason": "user changes go through the accounts API"}]


def test_server_events_climb_like_a_devices(db, admin):
    for n in range(3):
        invite(db, admin, name=f"U{n}", email=f"u{n}@example.org", now=T0 + n)
    seqs = [e.device_seq for e in in_replay_order(db) if e.device_id == SERVER_DEVICE]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
