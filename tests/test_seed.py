"""seed.toml, as the container reads it at every start."""

from __future__ import annotations

import io
from pathlib import Path

import pytest

from gear_tracker import accounts, derived, events, mail, seed
from gear_tracker.accounts import SignIn
from gear_tracker.cli import main
from gear_tracker.db import open_db
from gear_tracker.errors import BadRequest, Unauthorized

FILE = """\
[admin]
name = "Alex"
email = "alex@example.org"
password = "correct horse"

[group]
name = "10th Richmond"
code_url = "https://example.org/gear"
contact = "604-555-0100"
overdue_days = 30

[mail]
host = "smtp.example.org"
port = 465
encryption = "ssl"
username = "gear@example.org"
password = "app password"
from_address = "gear@example.org"
"""

NO_MAIL = FILE.split("[mail]")[0]


def written(tmp_path: Path, text: str = FILE) -> Path:
    path = tmp_path / "seed.toml"
    path.write_text(text)
    return path


def apply(conn, tmp_path: Path, text: str = FILE) -> list[str]:
    return seed.apply(conn, seed.read(written(tmp_path, text)))


def events_in(conn) -> int:
    return conn.execute("SELECT count(*) FROM events").fetchone()[0]


def group(conn) -> dict:
    return derived.get_entity(conn, "setting", "group") or {}


def run(monkeypatch, capsys, *args, stdin=""):
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    code = main(list(args))
    out = capsys.readouterr()
    return code, out.out, out.err


# --- an empty database ------------------------------------------------------------


def test_seeds_everything(db, tmp_path):
    done = apply(db, tmp_path)

    assert done == ["created Admin alex@example.org", "created the group setting", "set mail"]
    user_id = accounts.user_id_of(db, "alex@example.org")
    assert user_id is not None
    assert accounts.get_user(db, user_id)["role"] == "admin"
    assert accounts.sign_in(db, SignIn(email="alex@example.org", password="correct horse", device_id="p"))
    assert (
        group(db).items()
        >= {
            "name": "10th Richmond",
            "code_url": "https://example.org/gear",
            "contact": "604-555-0100",
            "overdue_days": 30,
        }.items()
    )
    assert mail.describe(db) == {
        "host": "smtp.example.org",
        "port": 465,
        "encryption": "ssl",
        "username": "gear@example.org",
        "from_address": "gear@example.org",
        "has_password": True,
    }


def test_the_group_setting_is_the_admins_own_event(db, tmp_path):
    apply(db, tmp_path)
    user_id = accounts.user_id_of(db, "alex@example.org")
    setting = db.execute("SELECT * FROM events WHERE entity_type = 'setting'").fetchone()
    assert setting["actor_id"] == user_id
    assert setting["type"] == "created"
    assert setting["device_id"] == "server"


def test_blank_and_missing_fields_are_absence(db, tmp_path):
    text = NO_MAIL.replace('contact = "604-555-0100"', 'contact = "  "').replace("overdue_days = 30\n", "")
    apply(db, tmp_path, text)

    assert group(db)["contact"] is None
    assert group(db)["overdue_days"] is None


# --- running it again -------------------------------------------------------------


def test_an_unchanged_file_writes_nothing(db, tmp_path):
    apply(db, tmp_path)
    before = events_in(db)

    assert apply(db, tmp_path) == []
    assert events_in(db) == before


def test_a_changed_field_writes_one_event(db, tmp_path):
    apply(db, tmp_path)
    before = events_in(db)

    done = apply(db, tmp_path, FILE.replace("overdue_days = 30", "overdue_days = 14"))

    assert done == ["set group.overdue_days"]
    assert events_in(db) == before + 1
    assert group(db)["overdue_days"] == 14
    change = db.execute("SELECT payload FROM events ORDER BY seq DESC LIMIT 1").fetchone()["payload"]
    assert '"old":30' in change


def test_a_field_changed_in_the_app_goes_back(db, tmp_path):
    """The file wins on config: it is the record of what this instance is."""
    apply(db, tmp_path)
    user_id = accounts.user_id_of(db, "alex@example.org")
    assert user_id is not None
    events.append_server(
        db, user_id, "setting", "group", "field_changed", {"field": "contact", "value": "someone else", "old": None}
    )

    assert apply(db, tmp_path) == ["set group.contact"]
    assert group(db)["contact"] == "604-555-0100"


def test_an_admin_with_that_email_is_left_alone(db, tmp_path):
    apply(db, tmp_path)
    user_id = accounts.user_id_of(db, "alex@example.org")
    assert user_id is not None

    assert apply(db, tmp_path, FILE.replace('name = "Alex"', 'name = "Someone Else"')) == []
    assert accounts.user_id_of(db, "alex@example.org") == user_id
    assert accounts.get_user(db, user_id)["name"] == "Alex"


def test_a_password_changed_in_the_app_is_left_alone(db, tmp_path):
    """The file's password is used once, at creation (FR-USR-13)."""
    apply(db, tmp_path)
    user_id = accounts.user_id_of(db, "alex@example.org")
    assert user_id is not None
    token = accounts._issue_link(db, user_id, "reset", accounts.now_ms())
    accounts.redeem(db, accounts.Redeem(token=token, password="chosen in the app", device_id="p"))

    assert apply(db, tmp_path) == []
    assert accounts.sign_in(db, SignIn(email="alex@example.org", password="chosen in the app", device_id="p"))
    with pytest.raises(Unauthorized):
        accounts.sign_in(db, SignIn(email="alex@example.org", password="correct horse", device_id="p"))


def test_a_new_email_makes_a_second_admin(db, tmp_path):
    """create-admin refuses this; the file may name a new Admin after the first one was made in the app."""
    apply(db, tmp_path)

    done = apply(db, tmp_path, FILE.replace("alex@example.org", "sam@example.org"))

    assert done[0] == "created Admin sam@example.org"
    assert accounts.active_admins(db) == 2


# --- mail -------------------------------------------------------------------------


def test_no_mail_section_leaves_mail_alone(db, tmp_path):
    apply(db, tmp_path)

    assert apply(db, tmp_path, NO_MAIL) == []
    described = mail.describe(db)
    assert described is not None
    assert described["host"] == "smtp.example.org"


def test_no_mail_section_and_none_stored_configures_nothing(db, tmp_path):
    assert apply(db, tmp_path, NO_MAIL) == ["created Admin alex@example.org", "created the group setting"]
    assert not mail.configured(db)


def test_a_changed_mail_field_is_stored(db, tmp_path):
    apply(db, tmp_path)

    assert apply(db, tmp_path, FILE.replace("port = 465", "port = 587")) == ["set mail"]
    described = mail.describe(db)
    assert described is not None
    assert described["port"] == 587


def test_a_changed_mail_password_is_stored(db, tmp_path):
    apply(db, tmp_path)

    assert apply(db, tmp_path, FILE.replace('password = "app password"', 'password = "a new one"')) == ["set mail"]
    saved = mail.get(db)
    assert saved is not None
    assert saved["password"] == "a new one"


def test_a_blank_mail_password_keeps_the_stored_one(db, tmp_path):
    apply(db, tmp_path)

    assert apply(db, tmp_path, FILE.replace('password = "app password"', 'password = ""')) == []
    kept = mail.get(db)
    assert kept is not None
    assert kept["password"] == "app password"


# --- a file that will not do ------------------------------------------------------


def test_a_missing_file(tmp_path):
    with pytest.raises(BadRequest, match="no seed file at"):
        seed.read(tmp_path / "nothing.toml")


def test_a_file_that_is_not_toml(tmp_path):
    with pytest.raises(BadRequest, match="not valid TOML"):
        seed.read(written(tmp_path, "[admin\nname ="))


def test_a_missing_section(tmp_path):
    with pytest.raises(BadRequest, match="group: Field required"):
        seed.read(written(tmp_path, FILE.split("[group]")[0]))


def test_a_short_password(tmp_path):
    with pytest.raises(BadRequest, match="admin.password"):
        seed.read(written(tmp_path, FILE.replace('password = "correct horse"', 'password = "short"')))


def test_a_mistyped_key(tmp_path):
    """An unknown key is a typo, and a typo that seeds nothing is worse than an error."""
    with pytest.raises(BadRequest, match="overdue: Extra inputs are not permitted"):
        seed.read(written(tmp_path, FILE.replace("overdue_days = 30", "overdue = 30")))


def test_overdue_days_is_a_count_of_days(tmp_path):
    with pytest.raises(BadRequest, match="group.overdue_days"):
        seed.read(written(tmp_path, FILE.replace("overdue_days = 30", 'overdue_days = "thirty"')))


def test_the_inventory_key_is_accepted(tmp_path):
    """Parsed now, loaded by a later task. Above the sections: TOML would read it as one of their keys."""
    assert seed.read(written(tmp_path, 'inventory = "demo"\n' + FILE)).inventory == "demo"


def test_the_committed_example_parses(tmp_path):
    """It is what a volunteer copies to the server, so a typo in it costs someone an evening."""
    example = Path(__file__).parent.parent / "seed.example.toml"

    spec = seed.read(example)

    assert spec.group.name
    assert spec.mail is None
    assert spec.inventory is None


# --- through the command line -----------------------------------------------------


def test_gear_admin_seed(tmp_path, monkeypatch, capsys):
    db_path = tmp_path / "fresh.db"
    path = written(tmp_path)

    code, out, err = run(monkeypatch, capsys, "--db", str(db_path), "seed", "--file", str(path))

    assert code == 0, err
    assert out.splitlines() == ["created Admin alex@example.org", "created the group setting", "set mail"]
    with open_db(db_path) as conn:
        assert accounts.sign_in(conn, SignIn(email="alex@example.org", password="correct horse", device_id="p"))

    code, out, err = run(monkeypatch, capsys, "--db", str(db_path), "seed", "--file", str(path))
    assert code == 0, err
    assert out.strip() == "nothing to do"


def test_gear_admin_seed_with_a_bad_file(tmp_path, monkeypatch, capsys):
    path = written(tmp_path, "not toml at all")

    code, out, err = run(monkeypatch, capsys, "--db", str(tmp_path / "g.db"), "seed", "--file", str(path))

    assert code == 1
    assert "not valid TOML" in err
    assert out == ""
