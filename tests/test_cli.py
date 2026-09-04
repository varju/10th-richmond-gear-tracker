"""gear-admin, as the installing volunteer runs it."""

from __future__ import annotations

import io
import json

import pytest

from gear_tracker import accounts, derived
from gear_tracker.accounts import Invite, Redeem, SignIn
from gear_tracker.cli import main
from gear_tracker.db import open_db
from gear_tracker.errors import Unauthorized
from gear_tracker.events import append_server
from gear_tracker.sync import Principal


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


# --- export and import -------------------------------------------------------------------


def with_admin(tmp_path, monkeypatch, capsys, name="fresh.db"):
    db = tmp_path / name
    code, _, err = run(
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
    return db


def test_export_then_import_dry_run_finds_nothing_to_do(tmp_path, monkeypatch, capsys):
    db = with_admin(tmp_path, monkeypatch, capsys)
    out_file = tmp_path / "out.csv"

    code, out, err = run(monkeypatch, capsys, "--db", str(db), "export", "--out", str(out_file))
    assert code == 0, err
    assert out.strip() == f"wrote {out_file}"
    assert out_file.is_file()

    code, out, err = run(monkeypatch, capsys, "--db", str(db), "import", "--file", str(out_file), "--dry-run")
    assert code == 0, err
    assert out.strip() == "0 to add, 0 to change, 0 unchanged"


def test_editing_the_exported_file_and_importing_it_applies_the_change(tmp_path, monkeypatch, capsys):
    db = with_admin(tmp_path, monkeypatch, capsys)
    with open_db(db) as conn:
        actor = accounts.first_admin(conn)
        assert actor is not None
        append_server(conn, actor, "item", "tent-1", "created", {"name": "Tent"})

    out_file = tmp_path / "out.csv"
    run(monkeypatch, capsys, "--db", str(db), "export", "--out", str(out_file))
    edited = out_file.read_text().replace("tent-1,single,Tent,", "tent-1,single,Family tent,")
    out_file.write_text(edited)

    code, out, err = run(monkeypatch, capsys, "--db", str(db), "import", "--file", str(out_file))
    assert code == 0, err
    assert out.strip().startswith("added 0, changed 1")

    with open_db(db) as conn:
        assert derived.snapshot(conn)["item"]["tent-1"]["name"] == "Family tent"


# --- rebuild -------------------------------------------------------------------------------


def test_rebuild_backfills_a_derived_field_added_after_the_fact(tmp_path, monkeypatch, capsys):
    """A user deactivated before `deactivated_at` existed shows a bare "Deactivated" forever,
    because the cache is only ever updated incrementally. `rebuild` is the operator's way out."""
    db = with_admin(tmp_path, monkeypatch, capsys)
    with open_db(db) as conn:
        admin_id = accounts.first_admin(conn)
        assert admin_id is not None
        who = Principal(user_id=admin_id, device_id="server", active=True, role="admin")
        user_id, _ = accounts.invite(conn, who, Invite(name="Bea", email="bea@example.org", role="user"))
        accounts.deactivate(conn, who, user_id)

        # Simulate the pre-upgrade cache: the field the old code never wrote.
        state = derived.get_entity(conn, "user", user_id)
        assert state is not None
        deactivated_at = state["deactivated_at"]
        assert deactivated_at is not None
        del state["deactivated_at"]
        conn.execute(
            "UPDATE entities SET state = ? WHERE entity_type = 'user' AND entity_id = ?",
            (json.dumps(state, sort_keys=True), user_id),
        )
        assert derived.get_entity(conn, "user", user_id) == state

    code, out, err = run(monkeypatch, capsys, "--db", str(db), "rebuild")
    assert code == 0, err
    assert out.strip() == "rebuilt 2 entities"

    with open_db(db) as conn:
        rebuilt = derived.get_entity(conn, "user", user_id)
        assert rebuilt is not None
        assert rebuilt["deactivated_at"] == deactivated_at
