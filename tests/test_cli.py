"""gear-admin, as the installing volunteer runs it."""

from __future__ import annotations

import io

import pytest

from gear_tracker import accounts
from gear_tracker.accounts import Redeem, SignIn
from gear_tracker.cli import main
from gear_tracker.db import open_db
from gear_tracker.errors import Unauthorized


def run(monkeypatch, capsys, *args, stdin=""):
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    code = main(list(args))
    out = capsys.readouterr()
    return code, out.out, out.err


def test_create_admin_migrates_and_creates(tmp_path, monkeypatch, capsys):
    db = tmp_path / "fresh.db"
    code, out, err = run(
        monkeypatch,
        capsys,
        "--db",
        str(db),
        "create-admin",
        "--name",
        "Alex",
        "--email",
        "alex@example.org",
        "--password-stdin",
        stdin="correct horse\n",
    )
    assert code == 0, err
    assert out.startswith("created Admin alex@example.org")

    with open_db(db) as conn:
        session = accounts.sign_in(conn, SignIn(email="alex@example.org", password="correct horse", device_id="p"))
        assert session.user["role"] == "admin"


def test_create_admin_refuses_a_second_time(tmp_path, monkeypatch, capsys):
    db = str(tmp_path / "g.db")
    args = ("--db", db, "create-admin", "--name", "Alex", "--email", "alex@example.org", "--password-stdin")
    assert run(monkeypatch, capsys, *args, stdin="correct horse\n")[0] == 0
    code, _, err = run(monkeypatch, capsys, *args, stdin="correct horse\n")
    assert code == 1
    assert "already exists" in err


def test_create_admin_wants_a_real_password(tmp_path, monkeypatch, capsys):
    code, _, err = run(
        monkeypatch,
        capsys,
        "--db",
        str(tmp_path / "g.db"),
        "create-admin",
        "--name",
        "A",
        "--email",
        "a@example.org",
        "--password-stdin",
        stdin="short\n",
    )
    assert code == 1
    assert "8 characters" in err


def test_reset_link_gets_a_locked_out_admin_back_in(tmp_path, monkeypatch, capsys):
    db = str(tmp_path / "g.db")
    run(
        monkeypatch,
        capsys,
        "--db",
        db,
        "create-admin",
        "--name",
        "Alex",
        "--email",
        "alex@example.org",
        "--password-stdin",
        stdin="forgotten one\n",
    )

    code, out, _ = run(monkeypatch, capsys, "--db", db, "reset-link", "--email", "alex@example.org")
    assert code == 0
    token = out.strip()

    with open_db(db) as conn:
        session = accounts.redeem(conn, Redeem(token=token, password="remembered now", device_id="p"))
        assert session.user["role"] == "admin"
        with pytest.raises(Unauthorized):
            accounts.sign_in(conn, SignIn(email="alex@example.org", password="forgotten one", device_id="p"))


def test_reset_link_for_nobody(tmp_path, monkeypatch, capsys):
    code, _, err = run(monkeypatch, capsys, "--db", str(tmp_path / "g.db"), "reset-link", "--email", "x@example.org")
    assert code == 1
    assert "no account" in err
