"""Accounts against the real database: sign-in, links, roles, and the audit trail they leave."""

from __future__ import annotations

import pydantic
import pytest

from gear_tracker import accounts
from gear_tracker.accounts import Invite, Redeem, SignIn
from gear_tracker.db import connect
from gear_tracker.derived import snapshot
from gear_tracker.errors import (
    BadRequest,
    Conflict,
    Deactivated,
    Forbidden,
    InviteUsed,
    NotFound,
    ResetUsed,
    Unauthorized,
)
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
    reauthed = accounts.authenticate(db, again.token)
    assert reauthed is not None and reauthed.device_id == "tablet"


def test_an_invite_is_an_audited_event_with_the_admin_as_actor(db, admin):
    user_id, _ = invite(db, admin)
    created = [e for e in in_replay_order(db) if e.entity_id == user_id]
    assert [e.type for e in created] == ["created"]
    assert created[0].actor_id == admin.user_id


def test_email_is_not_on_the_log(db, admin):
    user_id, _ = invite(db, admin)
    assert "email" not in snapshot(db)["user"][user_id]
    assert "email" not in " ".join(str(e.payload) for e in in_replay_order(db))


def test_a_spent_invite_says_the_account_already_exists(db, admin):
    """A second click on the same invite is not the same failure as a broken link: the person
    already has an account, so the Join page can point them at Sign in instead (FR-USR-12).
    """
    _, token = invite(db, admin)
    join(db, token)
    with pytest.raises(InviteUsed, match="already have an account"):
        join(db, token)


def test_a_spent_reset_link_says_to_ask_an_admin(db, admin):
    """There is no self-service retry for a reset, so the message says who to ask."""
    user_id, _ = invite(db, admin)
    token = accounts.reset_link(db, admin, user_id, now=T0)
    join(db, token, password="new password")
    with pytest.raises(ResetUsed, match="ask an Admin"):
        join(db, token, password="another password")


def test_a_link_dies_after_a_week(db, admin):
    _, token = invite(db, admin, now=T0)
    with pytest.raises(Unauthorized, match="not valid"):
        join(db, token, now=T0 + accounts.LINK_TTL_MS + 1)


def test_a_made_up_link_is_refused(db, admin):
    """Unknown and expired links give the same answer, so neither leaks whether a token ever existed."""
    with pytest.raises(Unauthorized, match="not valid") as unknown:
        join(db, "nope")
    assert unknown.value.code == "unauthorized"


def test_two_redeems_of_the_same_link_the_second_is_refused(db, db_path, admin):
    """The check and the spend are one transaction (a concurrent redeem must not both succeed).

    Two connections, so the second reads what the first actually committed
    rather than sharing Python state with it. Sequential calls are enough to
    show the guard: the second's UPDATE matches no row once the first has run.
    """
    _, token = invite(db, admin)
    other = connect(db_path)
    try:
        join(db, token)
        with pytest.raises(InviteUsed, match="already have an account"):
            accounts.redeem(other, Redeem(token=token, password="another password", device_id="phone-c"), now=T0)
    finally:
        other.close()


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
    reauthed = accounts.authenticate(db, new.token)
    assert reauthed is not None and reauthed.device_id == "phone-c"
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
    assert accounts.get_user(db, user_id)["deactivated_at"] == T0 + 1


def test_a_deactivated_users_final_push_still_lands(db, admin):
    """FR-OFF-06 end to end: through a real session."""
    user_id, token = invite(db, admin)
    session = join(db, token, device="phone-b")
    accounts.deactivate(db, admin, user_id, now=T0)

    who = accounts.authenticate(db, session.token)
    assert who is not None
    event = incoming(actor_id=user_id, device_id="phone-b", type="checked_in", payload={})
    result = push(db, who, {"device_id": "phone-b", "client_time": T0, "events": [event]}, now=T0)

    assert result["accepted"] == [event["id"]]


def test_reactivation_restores_access(db, admin):
    user_id, token = invite(db, admin)
    session = join(db, token)
    accounts.deactivate(db, admin, user_id, now=T0)
    accounts.reactivate(db, admin, user_id, now=T0 + 1)

    reactivated = accounts.authenticate(db, session.token)
    assert reactivated is not None and reactivated.active is True
    assert accounts.get_user(db, user_id)["active"] is True
    assert not accounts.get_user(db, user_id)["deactivated_at"]


def test_an_admin_cannot_drop_their_own_role(db, admin):
    """FR-USR-22. Not even with another Admin standing by: the mistake is one nobody can undo alone."""
    bea_id, _ = invite(db, admin, role="admin")
    bea = Principal(user_id=bea_id, device_id="phone-b", active=True, role="admin")

    with pytest.raises(Conflict, match="your own Admin role"):
        accounts.set_role(db, admin, admin.user_id, "user", now=T0)
    assert accounts.get_user(db, admin.user_id)["role"] == "admin"

    # The other Admin still can, and promoting yourself is not a demotion.
    accounts.set_role(db, admin, admin.user_id, "admin", now=T0)
    accounts.set_role(db, bea, admin.user_id, "user", now=T0 + 1)
    assert accounts.get_user(db, admin.user_id)["role"] == "user"


def test_an_admin_cannot_deactivate_themself(db, admin):
    """FR-USR-23. The app already refused; the server refuses too, so the assistant cannot do it either."""
    bea_id, _ = invite(db, admin, role="admin")
    bea = Principal(user_id=bea_id, device_id="phone-b", active=True, role="admin")

    with pytest.raises(Conflict, match="your own account"):
        accounts.deactivate(db, admin, admin.user_id, now=T0)
    assert accounts.get_user(db, admin.user_id)["active"] is True

    accounts.deactivate(db, bea, admin.user_id, now=T0 + 1)
    assert accounts.get_user(db, admin.user_id)["active"] is False


def test_the_last_admin_cannot_be_demoted_or_deactivated(db, admin):
    """FR-USR-03. With the self cases barred, only two Admins acting at once reach this: each holds a
    Principal read before the other's change landed, so both still pass for an Admin.
    """
    bea_id, _ = invite(db, admin, role="admin")
    bea = Principal(user_id=bea_id, device_id="phone-b", active=True, role="admin")
    accounts.set_role(db, bea, admin.user_id, "user", now=T0)

    with pytest.raises(Conflict, match="last Admin"):
        accounts.set_role(db, admin, bea_id, "user", now=T0 + 1)
    with pytest.raises(Conflict, match="last Admin"):
        accounts.deactivate(db, admin, bea_id, now=T0 + 1)
    assert accounts.get_user(db, bea_id)["role"] == "admin"
    assert accounts.get_user(db, bea_id)["active"] is True


def test_a_deactivated_admin_does_not_count(db, admin):
    bea_id, _ = invite(db, admin, role="admin")
    cal_id, _ = invite(db, admin, name="Cal", email="cal@example.org", role="admin")
    cal = Principal(user_id=cal_id, device_id="phone-c", active=True, role="admin")
    accounts.deactivate(db, admin, bea_id, now=T0)
    accounts.deactivate(db, cal, admin.user_id, now=T0)

    with pytest.raises(Conflict, match="last Admin"):
        accounts.deactivate(db, admin, cal_id, now=T0)


def test_the_last_admin_guard_and_the_write_are_one_transaction(db, db_path, admin):
    """The guard reads inside the same transaction as the write; ordinary behaviour is unchanged.

    A second connection, so the read that decides "am I the last Admin" is
    the one made durable by the first connection's commit, not a value
    already sitting in the calling process.
    """
    bea_id, _ = invite(db, admin, role="admin")
    bea = Principal(user_id=bea_id, device_id="phone-b", active=True, role="admin")
    other = connect(db_path)
    try:
        accounts.deactivate(other, bea, admin.user_id, now=T0)
        assert accounts.get_user(db, admin.user_id)["active"] is False
        # Alex's Principal predates that, as a request already in flight would have.
        with pytest.raises(Conflict, match="last Admin"):
            accounts.deactivate(other, admin, bea_id, now=T0)
        with pytest.raises(Conflict, match="last Admin"):
            accounts.set_role(other, admin, bea_id, "user", now=T0)
    finally:
        other.close()


# --- editing name and email --------------------------------------------------------------------


def test_a_rename_is_an_event_with_old_and_new(db, admin):
    user_id, _ = invite(db, admin)
    accounts.edit_user(db, admin, user_id, accounts.UserEdit(name="Beatrice"), now=T0 + 1)

    change = [e for e in in_replay_order(db) if e.entity_id == user_id][-1]
    assert change.type == "field_changed"
    assert change.payload == {"field": "name", "value": "Beatrice", "old": "Bea"}
    assert change.actor_id == admin.user_id
    assert accounts.get_user(db, user_id)["name"] == "Beatrice"


def test_an_email_change_is_not_on_the_log(db, admin):
    """Email is a credential, like at an invite: it is fixed in `accounts`, never as an event (see
    accounts.py's docstring, and test_email_is_not_on_the_log for the invite side of the same rule).
    """
    user_id, _ = invite(db, admin)
    before = db.execute("SELECT count(*) FROM events").fetchone()[0]

    accounts.edit_user(db, admin, user_id, accounts.UserEdit(email="beatrice@example.org"), now=T0 + 1)

    assert db.execute("SELECT count(*) FROM events").fetchone()[0] == before
    assert "email" not in " ".join(str(e.payload) for e in in_replay_order(db))
    assert accounts.email_of(db, user_id) == "beatrice@example.org"


def test_an_email_change_is_stored_lowercase(db, admin):
    user_id, _ = invite(db, admin)
    accounts.edit_user(db, admin, user_id, accounts.UserEdit(email="Beatrice@Example.ORG"), now=T0)
    assert accounts.email_of(db, user_id) == "beatrice@example.org"


def test_an_email_clash_is_a_conflict(db, admin):
    user_id, _ = invite(db, admin)
    with pytest.raises(Conflict, match="email"):
        accounts.edit_user(db, admin, user_id, accounts.UserEdit(email="Alex@Example.org"), now=T0)
    assert accounts.email_of(db, user_id) == "bea@example.org"


def test_a_no_op_email_change_writes_nothing(db, admin):
    user_id, _ = invite(db, admin)
    before = db.execute("SELECT count(*) FROM events").fetchone()[0]
    accounts.edit_user(db, admin, user_id, accounts.UserEdit(email="BEA@example.org"), now=T0)
    assert db.execute("SELECT count(*) FROM events").fetchone()[0] == before
    assert accounts.email_of(db, user_id) == "bea@example.org"


def test_edit_user_needs_at_least_one_field(db, admin):
    user_id, _ = invite(db, admin)
    with pytest.raises(BadRequest, match="say what to change"):
        accounts.edit_user(db, admin, user_id, accounts.UserEdit(), now=T0)


def test_an_email_change_keeps_open_sessions(db, admin):
    user_id, token = invite(db, admin)
    session = join(db, token)

    accounts.edit_user(db, admin, user_id, accounts.UserEdit(email="beatrice@example.org"), now=T0)

    assert accounts.authenticate(db, session.token) is not None
    accounts.sign_in(db, SignIn(email="beatrice@example.org", password="battery staple", device_id="p"), now=T0)


def test_editing_an_unknown_user(db, admin):
    with pytest.raises(NotFound):
        accounts.edit_user(db, admin, "01000000000000000000000000", accounts.UserEdit(name="X"), now=T0)
    with pytest.raises(NotFound):
        accounts.edit_user(db, admin, "01000000000000000000000000", accounts.UserEdit(email="x@example.org"), now=T0)


def test_users_cannot_edit_users(db, admin):
    user_id, _ = invite(db, admin)
    bea = Principal(user_id=user_id, device_id="phone-b", role="user")
    with pytest.raises(Forbidden):
        accounts.edit_user(db, bea, admin.user_id, accounts.UserEdit(name="Not Alex"))


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


# --- devices ---------------------------------------------------------------------------------


def test_revoking_a_device_ends_its_sessions_and_nothing_else(db, admin):
    user_id, token = invite(db, admin)
    lost = join(db, token, device="phone-lost")
    kept = accounts.sign_in(db, SignIn(email="bea@example.org", password="battery staple", device_id="phone-kept"))
    assert [d["device_id"] for d in accounts.list_devices(db, admin, user_id)] == ["phone-kept", "phone-lost"]

    before = list(in_replay_order(db))
    left = accounts.revoke_device(db, admin, user_id, "phone-lost", now=T0)

    assert [d["device_id"] for d in left] == ["phone-kept"]
    assert accounts.authenticate(db, lost.token) is None
    still_kept = accounts.authenticate(db, kept.token)
    assert still_kept is not None and still_kept.device_id == "phone-kept"
    assert accounts.get_user(db, user_id)["active"] is True
    assert list(in_replay_order(db)) == before, "sessions only; nothing on the log"
    # The account is untouched, so the same phone can sign in again.
    accounts.sign_in(db, SignIn(email="bea@example.org", password="battery staple", device_id="phone-lost"))


def test_an_admin_cannot_revoke_the_device_they_are_using(db, admin):
    session = accounts.sign_in(db, SignIn(email="alex@example.org", password="correct horse", device_id="a"))
    me = accounts.authenticate(db, session.token)
    assert me is not None
    with pytest.raises(Conflict, match="sign out instead"):
        accounts.revoke_device(db, me, admin.user_id, "a")
    assert accounts.authenticate(db, session.token) is not None


def test_users_manage_their_own_devices(db, admin):
    user_id, token = invite(db, admin)
    session = join(db, token)
    bea = accounts.authenticate(db, session.token)
    assert bea is not None
    accounts.sign_in(db, SignIn(email="bea@example.org", password="battery staple", device_id="phone-b2"), now=T0)

    devices = accounts.list_devices(db, bea, user_id)
    assert {d["device_id"] for d in devices} == {"phone-b", "phone-b2"}

    remaining = accounts.revoke_device(db, bea, user_id, "phone-b2")
    assert [d["device_id"] for d in remaining] == ["phone-b"]

    cal_id, cal_token = invite(db, admin, name="Cal", email="cal@example.org")
    join(db, cal_token, device="phone-c")
    with pytest.raises(Forbidden):
        accounts.list_devices(db, bea, cal_id)
    with pytest.raises(Forbidden):
        accounts.revoke_device(db, bea, cal_id, "phone-c")

    with pytest.raises(Conflict, match="sign out instead"):
        accounts.revoke_device(db, bea, user_id, "phone-b")

    accounts.deactivate(db, admin, user_id, now=T0)
    gone = accounts.authenticate(db, session.token)
    assert gone is not None and gone.active is False
    with pytest.raises(Deactivated):
        accounts.list_devices(db, gone, user_id)


def test_admin_lists_or_revokes_devices_for_nobody(db, admin):
    with pytest.raises(NotFound):
        accounts.list_devices(db, admin, "nobody")


# --- standing join links (FR-USR-19) ----------------------------------------------------------


def make_join_link(db, admin, expiry_days=7, label="", now=T0):
    body = accounts.CreateJoinLink(expiry_days=expiry_days, label=label)
    return accounts.create_join_link(db, admin, body, now=now)


def use_join_link(db, token, name="Bea", email="bea@example.org", password="battery staple", device="phone-b", now=T0):
    body = accounts.Join(link=token, name=name, email=email, password=password, device_id=device)
    return accounts.join(db, body, now=now)


def test_an_admin_creates_a_join_link_and_lists_it(db, admin):
    made = make_join_link(db, admin, now=T0)
    assert made["token"]
    assert made["created_by"] == admin.user_id
    assert made["created_at"] == T0
    assert made["expires_at"] == T0 + 7 * accounts.DAY_MS

    [listed] = accounts.list_join_links(db, admin, now=T0)
    assert listed["id"] == made["id"]
    assert listed["created_by"] == admin.user_id
    assert listed["created_by_name"] == "Alex"
    assert listed["expires_at"] == made["expires_at"]
    assert "token" not in listed


def test_a_join_link_carries_the_label_it_was_made_with(db, admin):
    made = make_join_link(db, admin, label="Beaver leaders", now=T0)
    assert made["label"] == "Beaver leaders"
    [listed] = accounts.list_join_links(db, admin, now=T0)
    assert listed["label"] == "Beaver leaders"


def test_a_link_made_without_a_label_has_an_empty_one(db, admin):
    make_join_link(db, admin, now=T0)
    [listed] = accounts.list_join_links(db, admin, now=T0)
    assert listed["label"] == ""


def test_an_admin_renames_a_link_and_can_clear_the_label(db, admin):
    made = make_join_link(db, admin, label="Beaver leaders", now=T0)

    accounts.rename_join_link(db, admin, made["id"], "September open house")
    [listed] = accounts.list_join_links(db, admin, now=T0)
    assert listed["label"] == "September open house"

    accounts.rename_join_link(db, admin, made["id"], "")
    [listed] = accounts.list_join_links(db, admin, now=T0)
    assert listed["label"] == ""


def test_renaming_a_link_leaves_its_token_working(db, admin):
    made = make_join_link(db, admin, label="Beaver leaders", now=T0)
    accounts.rename_join_link(db, admin, made["id"], "Cub leaders")
    assert use_join_link(db, made["token"], now=T0 + 1).user["name"] == "Bea"


def test_renaming_a_link_that_is_not_there_is_not_found(db, admin):
    with pytest.raises(NotFound):
        accounts.rename_join_link(db, admin, "nope", "Beaver leaders")


def test_a_label_is_trimmed_and_bounded(db, admin):
    assert accounts.CreateJoinLink(label="  Beaver leaders  ").label == "Beaver leaders"
    with pytest.raises(pydantic.ValidationError):
        accounts.CreateJoinLink(label="x" * 101)


def test_a_join_links_expiry_is_one_of_three_choices_or_never(db, admin):
    for days in (1, 7, 30):
        made = make_join_link(db, admin, expiry_days=days, now=T0)
        assert made["expires_at"] == T0 + days * accounts.DAY_MS
    made = make_join_link(db, admin, expiry_days=None, now=T0)
    assert made["expires_at"] is None
    with pytest.raises(pydantic.ValidationError):
        accounts.CreateJoinLink(expiry_days=14)  # type: ignore


def test_a_join_link_with_no_expiry_stays_good_and_listed_far_into_the_future(db, admin):
    made = make_join_link(db, admin, expiry_days=None, now=T0)
    session = use_join_link(db, made["token"], now=T0 + 100 * 365 * DAY)
    assert session.user["name"] == "Bea"
    [listed] = accounts.list_join_links(db, admin, now=T0 + 100 * 365 * DAY)
    assert listed["expires_at"] is None


def test_a_user_cannot_create_list_or_revoke_a_join_link(db, admin):
    user_id, _ = invite(db, admin)
    bea = Principal(user_id=user_id, device_id="phone-b", role="user")
    with pytest.raises(Forbidden):
        accounts.create_join_link(db, bea, accounts.CreateJoinLink())
    with pytest.raises(Forbidden):
        accounts.list_join_links(db, bea)
    with pytest.raises(Forbidden):
        accounts.revoke_join_link(db, bea, "nope")
    with pytest.raises(Forbidden):
        accounts.rename_join_link(db, bea, "nope", "Beaver leaders")


def test_joining_creates_a_user_audited_under_the_link_creators_name(db, admin):
    made = make_join_link(db, admin, now=T0)
    session = use_join_link(db, made["token"], now=T0 + 1)

    assert session.user["name"] == "Bea"
    assert session.user["role"] == "user"
    assert accounts.authenticate(db, session.token) == Principal(session.user["id"], "phone-b", True, "user")

    created = [e for e in in_replay_order(db) if e.entity_id == session.user["id"]]
    assert [e.type for e in created] == ["created"]
    assert created[0].actor_id == admin.user_id, "the audit log says who let them in (FR-USR-05)"


def test_an_unknown_join_link_is_refused(db, admin):
    with pytest.raises(Unauthorized, match="not valid"):
        use_join_link(db, "nope")


def test_an_expired_join_link_is_refused(db, admin):
    made = make_join_link(db, admin, expiry_days=1, now=T0)
    with pytest.raises(Unauthorized, match="not valid"):
        use_join_link(db, made["token"], now=T0 + DAY + 1)


def test_a_revoked_join_link_is_refused(db, admin):
    made = make_join_link(db, admin, now=T0)
    accounts.revoke_join_link(db, admin, made["id"], now=T0)
    with pytest.raises(Unauthorized, match="not valid"):
        use_join_link(db, made["token"])


def test_a_join_link_stays_good_for_a_second_person_after_a_first_joins(db, admin):
    """Unlike an invite or reset link, a standing link is not spent by one use (FR-USR-19)."""
    made = make_join_link(db, admin, now=T0)
    use_join_link(db, made["token"], name="Bea", email="bea@example.org", device="phone-b", now=T0)
    second = use_join_link(db, made["token"], name="Cal", email="cal@example.org", device="phone-c", now=T0)
    assert second.user["name"] == "Cal"


def test_joining_with_an_email_already_in_use_is_a_conflict(db, admin):
    made = make_join_link(db, admin, now=T0)
    with pytest.raises(Conflict, match="sign in instead"):
        use_join_link(db, made["token"], email="alex@example.org")


def test_revoking_a_join_link_drops_it_from_the_list(db, admin):
    made = make_join_link(db, admin, now=T0)
    accounts.revoke_join_link(db, admin, made["id"], now=T0)
    assert accounts.list_join_links(db, admin, now=T0) == []


def test_revoking_an_unknown_join_link_is_not_found(db, admin):
    with pytest.raises(NotFound):
        accounts.revoke_join_link(db, admin, "nope")


def test_an_expired_join_link_does_not_appear_in_the_list(db, admin):
    make_join_link(db, admin, expiry_days=1, now=T0)
    assert accounts.list_join_links(db, admin, now=T0 + DAY + 1) == []
