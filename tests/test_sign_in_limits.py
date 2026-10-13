"""Guessing passwords: the lock per email, the dummy check, and what a new password may be (NFR-SEC-12 to -26)."""

from __future__ import annotations

import threading
import time

import pydantic
import pytest

from gear_tracker import accounts, passwords
from gear_tracker.accounts import Invite, Join, Redeem, SignIn
from gear_tracker.db import connect
from gear_tracker.errors import BadRequest, CommonPassword, Forbidden, Locked, TooMany, Unauthorized
from gear_tracker.sync import Principal
from tests.factories import T0

MINUTE = 60_000
HOUR = 60 * MINUTE
DAY = 24 * HOUR


@pytest.fixture
def admin(db) -> Principal:
    user_id = accounts.create_admin(db, "Alex", "alex@example.org", "correct horse", now=T0)
    return Principal(user_id=user_id, device_id="server", active=True, role="admin")


def attempt(db, password="nope nope", email="alex@example.org", now=T0, device="p"):
    return accounts.sign_in(db, SignIn(email=email, password=password, device_id=device), now=now)


def fail(db, times, email="alex@example.org", now=T0):
    """Wrong passwords until the last one; returns what the last one raised."""
    for _ in range(times - 1):
        with pytest.raises(Unauthorized):
            attempt(db, email=email, now=now)
    with pytest.raises((Unauthorized, Locked)) as last:
        attempt(db, email=email, now=now)
    return last.value


def until(condition, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.005)


# --- the lock ------------------------------------------------------------------------------


def test_the_fifth_wrong_password_locks_for_fifteen_minutes(db, admin):
    last = fail(db, 5)
    assert isinstance(last, Locked)
    assert last.status == 429
    assert last.message == "Too many attempts. Try again in 15 minutes."


def test_four_wrong_passwords_do_not_lock(db, admin):
    assert not isinstance(fail(db, 4), Locked)
    assert attempt(db, "correct horse").user["id"] == admin.user_id


def test_a_locked_email_is_refused_even_with_the_right_password(db, admin):
    fail(db, 5)
    with pytest.raises(Locked, match="Try again in 10 minutes"):
        attempt(db, "correct horse", now=T0 + 5 * MINUTE)


def test_the_lock_lifts_by_itself(db, admin):
    fail(db, 5)
    assert attempt(db, "correct horse", now=T0 + 15 * MINUTE).user["id"] == admin.user_id


def test_the_lock_is_checked_before_any_hashing(db, admin, counting):
    fail(db, 5)
    before = counting.verified
    with pytest.raises(Locked):
        attempt(db, "correct horse", now=T0 + MINUTE)
    assert counting.verified == before


# --- guesses in parallel (NFR-SEC-26) ---------------------------------------------------------


def in_parallel(db_path, passwords_tried, now=T0):
    """Each on its own thread and its own connection, the way requests are. Returns what each raised, or None."""
    start = threading.Barrier(len(passwords_tried))
    out: list[BaseException | None] = [None] * len(passwords_tried)

    def run(n, password):
        conn = connect(db_path)
        try:
            start.wait()
            attempt(conn, password, now=now, device=f"p{n}")
        except BaseException as exc:  # noqa: BLE001 - the test reads it
            out[n] = exc
        finally:
            conn.close()

    threads = [threading.Thread(target=run, args=(n, p)) for n, p in enumerate(passwords_tried)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return out


def test_thirty_guesses_at_once_get_five_tries_and_one_lock(db_path, db, admin, counting):
    results = in_parallel(db_path, ["nope nope"] * 30)
    assert counting.verified == 5
    assert sum(isinstance(r, Unauthorized) for r in results) == 4
    assert sum(isinstance(r, Locked) for r in results) == 26
    row = db.execute("SELECT locks, locked_until FROM sign_in_locks").fetchone()
    assert (row["locks"], row["locked_until"]) == (1, T0 + 15 * MINUTE)


def test_a_right_password_in_flight_when_another_guess_locks_is_refused(db_path, db, admin, counting):
    """It was one of the five tries, but the lock landed first; clearing it would undo the lock."""
    fail(db, 3)
    counting.hold.add("correct horse")
    right: list[BaseException | None] = []

    def sign_in_right():
        conn = connect(db_path)
        try:
            attempt(conn, "correct horse", device="p1")
            right.append(None)
        except BaseException as exc:  # noqa: BLE001 - the test reads it
            right.append(exc)
        finally:
            conn.close()

    thread = threading.Thread(target=sign_in_right)
    thread.start()
    until(lambda: counting.running == 1)
    with pytest.raises(Locked):
        attempt(db)
    counting.gate.set()
    thread.join()
    assert isinstance(right[0], Locked)
    assert accounts.list_users(db, now=T0)[0]["locked_until"] == T0 + 15 * MINUTE


def test_the_right_password_as_the_fifth_try_signs_in(db, admin):
    fail(db, 4)
    assert attempt(db, "correct horse").user["id"] == admin.user_id
    assert db.execute("SELECT count(*) FROM sign_in_locks").fetchone()[0] == 0


def test_each_further_lock_doubles_the_wait(db, admin):
    fail(db, 5, now=T0)
    after_first = T0 + 15 * MINUTE
    second = fail(db, 5, now=after_first)
    assert second.message == "Too many attempts. Try again in 30 minutes."
    third = fail(db, 5, now=after_first + 30 * MINUTE)
    assert third.message == "Too many attempts. Try again in 1 hour."


def test_the_wait_stops_at_a_day(db, admin):
    now = T0
    for _ in range(8):
        fail(db, 5, now=now)
        now += DAY
    last = fail(db, 5, now=now)
    assert last.message == "Too many attempts. Try again in 24 hours."
    assert attempt(db, "correct horse", now=now + DAY).user["id"] == admin.user_id


def test_the_right_password_resets_the_count(db, admin):
    fail(db, 4)
    attempt(db, "correct horse")
    assert not isinstance(fail(db, 4), Locked)


def test_the_right_password_after_a_lock_resets_the_wait_too(db, admin):
    fail(db, 5)
    attempt(db, "correct horse", now=T0 + 15 * MINUTE)
    assert fail(db, 5, now=T0 + HOUR).message == "Too many attempts. Try again in 15 minutes."


def test_a_lock_survives_a_restart(db_path, db, admin):
    fail(db, 5)
    fresh = connect(db_path)
    try:
        with pytest.raises(Locked):
            attempt(fresh, "correct horse", now=T0 + MINUTE)
    finally:
        fresh.close()


def test_a_lock_leaves_signed_in_devices_signed_in(db, admin):
    session = attempt(db, "correct horse", device="phone")
    fail(db, 5)
    assert accounts.authenticate(db, session.token) is not None


def test_an_unknown_email_locks_the_same_way(db, admin):
    """Otherwise a lock would say the account exists."""
    known = fail(db, 5, email="alex@example.org")
    unknown = fail(db, 5, email="nobody@example.org")
    assert type(known) is type(unknown)
    assert known.message == unknown.message


def test_an_invited_email_with_no_password_yet_locks_the_same_way(db, admin):
    accounts.invite(db, admin, Invite(name="Bea", email="bea@example.org"), now=T0)
    assert isinstance(fail(db, 5, email="bea@example.org"), Locked)


def test_the_count_is_per_email_whatever_its_case(db, admin):
    fail(db, 4, email="Alex@Example.org")
    assert isinstance(fail(db, 1, email="ALEX@example.org"), Locked)


def test_one_email_locked_leaves_others_alone(db, admin):
    accounts.invite(db, admin, Invite(name="Bea", email="bea@example.org"), now=T0)
    fail(db, 5, email="bea@example.org")
    assert attempt(db, "correct horse").user["id"] == admin.user_id


def test_a_week_with_no_wrong_password_forgets_the_count(db, admin):
    fail(db, 4, email="nobody@example.org")
    fail(db, 1, email="someone@example.org", now=T0 + 7 * DAY + 1)
    assert [r["email"] for r in db.execute("SELECT email FROM sign_in_locks")] == ["someone@example.org"]


def test_a_new_password_from_a_reset_link_ends_the_lock(db, admin):
    fail(db, 5)
    token = accounts.reset_link(db, admin, admin.user_id, now=T0)
    accounts.redeem(db, Redeem(token=token, password="a new password", device_id="p2"), now=T0 + MINUTE)
    assert attempt(db, "a new password", now=T0 + MINUTE).user["id"] == admin.user_id


def test_redeeming_a_bad_link_costs_no_hashing(db, admin, counting):
    with pytest.raises(Unauthorized):
        accounts.redeem(db, Redeem(token="made up", password="a new password", device_id="p2"), now=T0)
    assert counting.hashed == 0


def test_redeeming_hashes_before_it_takes_the_write_lock(db_path, db, admin, counting):
    """A hash can wait for a slot longer than SQLite waits for the write lock."""
    token = accounts.reset_link(db, admin, admin.user_id, now=T0)
    counting.hold.add("a new password")
    thread = threading.Thread(
        target=lambda: accounts.redeem(
            connect(db_path), Redeem(token=token, password="a new password", device_id="p2"), now=T0
        )
    )
    thread.start()
    until(lambda: counting.hashed == 1)
    other = connect(db_path)
    other.execute("PRAGMA busy_timeout = 0")
    other.execute("BEGIN IMMEDIATE")
    other.execute("ROLLBACK")
    other.close()
    counting.gate.set()
    thread.join()
    assert attempt(db, "a new password").user["id"] == admin.user_id


def test_the_users_list_says_when_a_lock_ends(db, admin):
    fail(db, 5)
    [alex] = accounts.list_users(db, now=T0 + MINUTE)
    assert alex["locked_until"] == T0 + 15 * MINUTE
    [alex] = accounts.list_users(db, now=T0 + 15 * MINUTE)
    assert alex["locked_until"] is None


# --- unlocking (FR-USR-28, FR-USR-29, NFR-SEC-23 to -25) --------------------------------------------------------


def test_an_admin_unlocks_an_account(db, admin):
    bea_id, _ = accounts.invite(db, admin, Invite(name="Bea", email="bea@example.org"), now=T0)
    fail(db, 5, email="bea@example.org")
    accounts.unlock(db, admin, bea_id)
    assert accounts.list_users(db, now=T0)[1]["locked_until"] is None
    # The count went too: four more wrong passwords do not lock it again.
    assert not isinstance(fail(db, 4, email="bea@example.org"), Locked)


def test_unlocking_also_resets_the_doubling(db, admin):
    fail(db, 5)
    accounts.unlock(db, admin, admin.user_id)
    assert fail(db, 5).message == "Too many attempts. Try again in 15 minutes."


def test_a_user_cannot_unlock(db, admin):
    bea = Principal(user_id="bea", device_id="p", active=True, role="user")
    with pytest.raises(Forbidden):
        accounts.unlock(db, bea, admin.user_id)


def test_the_keyboard_unlocks_any_email(db, admin):
    fail(db, 5, email="nobody@example.org")
    assert accounts.unlock_email(db, "Nobody@example.org", now=T0) is True
    assert accounts.unlock_email(db, "nobody@example.org", now=T0) is False


def test_the_keyboard_says_a_count_with_no_lock_was_not_locked(db, admin):
    fail(db, 2)
    assert accounts.unlock_email(db, "alex@example.org", now=T0) is False
    assert not isinstance(fail(db, 4), Locked)


def test_the_keyboard_reads_an_email_the_way_sign_in_does(db, admin):
    composed, decomposed = "zo\u00eb@example.org", "zoe\u0308@example.org"
    fail(db, 5, email=decomposed)
    assert accounts.unlock_email(db, composed, now=T0) is True


# --- the same work for every email (NFR-SEC-19) ----------------------------------------------


def test_an_unknown_email_is_checked_against_a_dummy_hash(db, admin, counting):
    with pytest.raises(Unauthorized):
        attempt(db, email="nobody@example.org")
    assert counting.verified == 1


def test_an_account_with_no_password_yet_is_checked_against_a_dummy_hash(db, admin, counting):
    accounts.invite(db, admin, Invite(name="Bea", email="bea@example.org"), now=T0)
    with pytest.raises(Unauthorized):
        attempt(db, email="bea@example.org")
    assert counting.verified == 1


def test_the_dummy_hash_matches_nothing():
    assert passwords.verify(None, "") is False
    assert passwords.verify(None, "correct horse") is False


# --- a few checks at once (NFR-SEC-20) -------------------------------------------------------


def test_only_a_few_checks_run_at_once(counting):
    stored = passwords.hash("pw")
    counting.hold.add("pw")
    threads = [threading.Thread(target=passwords.verify, args=(stored, "pw")) for _ in range(10)]
    for t in threads:
        t.start()
    until(lambda: counting.running == passwords.CONCURRENT)
    time.sleep(0.05)  # room for a fourth to get in, if the cap let it
    assert counting.running == passwords.CONCURRENT
    counting.gate.set()
    for t in threads:
        t.join()
    assert counting.verified == 10
    assert counting.most == passwords.CONCURRENT


def test_a_busy_refusal_is_not_counted_as_a_wrong_password(db, admin, monkeypatch):
    monkeypatch.setattr(passwords, "WAIT_S", 0.01)
    fail(db, 4)
    held = [passwords._slots.acquire() for _ in range(passwords.CONCURRENT)]
    try:
        for _ in range(3):
            with pytest.raises(TooMany):
                attempt(db)
    finally:
        for _ in held:
            passwords._slots.release()
    assert attempt(db, "correct horse").user["id"] == admin.user_id


@pytest.mark.parametrize("locker_first", [True, False])
def test_refunds_in_either_order_leave_the_same_count(db, admin, locker_first):
    """Two attempts reserved, the second locking, then both refused as busy before their checks."""
    fail(db, 3)
    other = accounts._reserve(db, "alex@example.org", T0)
    locker = accounts._reserve(db, "alex@example.org", T0)
    assert (other, locker) == (None, T0 + 15 * MINUTE)
    for locked_by_me in [locker, other] if locker_first else [other, locker]:
        accounts._unreserve(db, "alex@example.org", locked_by_me)
    # Three real wrong passwords: the fourth does not lock, the fifth does.
    with pytest.raises(Unauthorized):
        attempt(db)
    with pytest.raises(Locked):
        attempt(db)


def test_a_busy_server_at_joining_leaves_no_account_without_a_password(db, admin, monkeypatch):
    made = accounts.create_join_link(db, admin, accounts.CreateJoinLink(), now=T0)
    body = Join(link=made["token"], name="Bea", email="bea@example.org", password="battery staple", device_id="p")
    monkeypatch.setattr(passwords, "WAIT_S", 0.01)
    held = [passwords._slots.acquire() for _ in range(passwords.CONCURRENT)]
    try:
        with pytest.raises(TooMany):
            accounts.join(db, body, now=T0)
    finally:
        for _ in held:
            passwords._slots.release()
    assert accounts.user_id_of(db, "bea@example.org") is None
    accounts.join(db, body, now=T0)
    assert attempt(db, "battery staple", email="bea@example.org").user["name"] == "Bea"


def test_a_check_with_no_free_slot_is_told_to_try_again(monkeypatch):
    monkeypatch.setattr(passwords, "WAIT_S", 0.01)
    held = [passwords._slots.acquire() for _ in range(passwords.CONCURRENT)]
    try:
        with pytest.raises(TooMany, match="busy"):
            passwords.verify(None, "correct horse")
    finally:
        for _ in held:
            passwords._slots.release()


# --- new passwords (NFR-SEC-21, NFR-SEC-22) --------------------------------------------------


def test_a_sign_in_password_is_capped():
    SignIn(email="a@example.org", password="x" * 256, device_id="p")
    with pytest.raises(pydantic.ValidationError):
        SignIn(email="a@example.org", password="x" * 257, device_id="p")


def test_a_new_password_is_capped():
    Redeem(token="t", password="x" * 256, device_id="p")
    with pytest.raises(pydantic.ValidationError):
        Redeem(token="t", password="x" * 257, device_id="p")
    with pytest.raises(BadRequest, match="at most 256"):
        passwords.check_new("x" * 257)


@pytest.mark.parametrize("common", ["password123", "PASSWORD123", "qwertyuiop", "iloveyou"])
def test_a_common_password_is_refused(common):
    with pytest.raises(CommonPassword) as refused:
        passwords.check_new(common)
    assert refused.value.code == "common_password"
    assert refused.value.status == 400


def test_an_uncommon_password_is_fine():
    passwords.check_new("correct horse")


def test_the_list_is_the_bundled_one():
    assert len(passwords.COMMON.read_text().splitlines()) == 100_000


def test_redeeming_with_a_common_password_is_refused_and_leaves_the_link_good(db, admin):
    _, token = accounts.invite(db, admin, Invite(name="Bea", email="bea@example.org"), now=T0)
    with pytest.raises(CommonPassword):
        accounts.redeem(db, Redeem(token=token, password="password123", device_id="p"), now=T0)
    accounts.redeem(db, Redeem(token=token, password="battery staple", device_id="p"), now=T0)


def test_joining_with_a_common_password_is_refused(db, admin):
    made = accounts.create_join_link(db, admin, accounts.CreateJoinLink(), now=T0)
    body = Join(link=made["token"], name="Bea", email="bea@example.org", password="iloveyou", device_id="p")
    with pytest.raises(CommonPassword):
        accounts.join(db, body, now=T0)
    assert accounts.user_id_of(db, "bea@example.org") is None


def test_the_first_admin_cannot_have_a_common_password(db):
    with pytest.raises(CommonPassword):
        accounts.create_admin(db, "Alex", "alex@example.org", "password123", now=T0)
