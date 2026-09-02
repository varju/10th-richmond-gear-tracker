"""The demo inventory, and the rule that it loads once."""

from __future__ import annotations

import io
from pathlib import Path

import pytest

from gear_tracker import accounts, derived, inventory, seed
from gear_tracker.cli import main
from gear_tracker.db import open_db
from gear_tracker.errors import BadRequest, Conflict

SMALL = """\
[[locations]]
name = "Cold locker"

[[locations]]
name = "Warm locker"

[[items]]
name = "Tarp, 10 by 12"
description = "Blue poly."
home = "Cold locker"
sub_location = "bin 2"

[[items.units]]
number = 1

[[items.units]]
number = 2
nickname = "torn corner"
home = "Warm locker"

[[items]]
name = "Trailer, 5 by 8"
home = "Cold locker"
purchase_date = "2021-03-06"
price = 240.0
supplier = "Local outfitter"
"""


def written(tmp_path: Path, text: str, name: str = "inv.toml") -> Path:
    path = tmp_path / name
    path.write_text(text)
    return path


def admin(conn) -> str:
    return accounts.install_admin(conn, "Alex", "alex@example.org", "correct horse")


def state(conn) -> dict:
    return derived.snapshot(conn)


def named(conn, name: str) -> dict:
    return next(fields for fields in state(conn)["item"].values() if fields.get("name") == name)


def run(monkeypatch, capsys, *args, stdin=""):
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    code = main(list(args))
    out = capsys.readouterr()
    return code, out.out, out.err


# --- loading ----------------------------------------------------------------------


def test_loads_locations_and_items(db, tmp_path):
    actor = admin(db)

    said = inventory.load(db, inventory.read(written(tmp_path, SMALL)), actor)

    assert said == "loaded 2 locations, 1 generic with 2 units, 1 single item"
    assert sorted(fields["name"] for fields in state(db)["location"].values()) == ["Cold locker", "Warm locker"]
    assert len(state(db)["item"]) == 4


def test_a_generic_carries_the_name_and_no_status(db, tmp_path):
    inventory.load(db, inventory.read(written(tmp_path, SMALL)), admin(db))

    tarp = named(db, "Tarp, 10 by 12")
    assert tarp["generic"] is True
    assert "status" not in tarp
    assert tarp["description"] == "Blue poly."


def test_units_hang_off_their_generic(db, tmp_path):
    inventory.load(db, inventory.read(written(tmp_path, SMALL)), admin(db))
    parent_id = next(k for k, v in state(db)["item"].items() if v.get("name") == "Tarp, 10 by 12")

    units = sorted(
        (fields for fields in state(db)["item"].values() if fields.get("parent_id") == parent_id),
        key=lambda fields: fields["number"],
    )

    assert [unit["number"] for unit in units] == [1, 2]
    assert [unit.get("nickname") for unit in units] == [None, "torn corner"]
    assert all(unit["status"] == "in" for unit in units)
    assert "name" not in units[0]


def test_a_unit_takes_its_home_from_the_generic(db, tmp_path):
    inventory.load(db, inventory.read(written(tmp_path, SMALL)), admin(db))
    cold = next(k for k, v in state(db)["location"].items() if v["name"] == "Cold locker")
    warm = next(k for k, v in state(db)["location"].items() if v["name"] == "Warm locker")
    units = [fields for fields in state(db)["item"].values() if fields.get("parent_id")]

    first = next(unit for unit in units if unit["number"] == 1)
    second = next(unit for unit in units if unit["number"] == 2)

    assert (first["home_location_id"], first["sub_location"]) == (cold, "bin 2")
    # Its own home; the generic's sub-location, which it did not override.
    assert (second["home_location_id"], second["sub_location"]) == (warm, "bin 2")


def test_a_single_item_keeps_its_paperwork(db, tmp_path):
    inventory.load(db, inventory.read(written(tmp_path, SMALL)), admin(db))

    trailer = named(db, "Trailer, 5 by 8")

    assert trailer["status"] == "in"
    assert (trailer["purchase_date"], trailer["price"], trailer["supplier"]) == ("2021-03-06", 240.0, "Local outfitter")


def test_it_is_the_admins_own_event(db, tmp_path):
    actor = admin(db)
    inventory.load(db, inventory.read(written(tmp_path, SMALL)), actor)

    row = db.execute("SELECT * FROM events WHERE entity_type = 'item' LIMIT 1").fetchone()

    assert (row["actor_id"], row["device_id"], row["type"]) == (actor, "server", "created")


def test_nothing_is_given_a_code(db, tmp_path):
    inventory.load(db, inventory.read(written(tmp_path, SMALL)), admin(db))

    assert state(db).get("code") is None


def test_it_refuses_a_database_with_items(db, tmp_path):
    actor = admin(db)
    inventory.load(db, inventory.read(written(tmp_path, SMALL)), actor)
    before = db.execute("SELECT count(*) FROM events").fetchone()[0]

    with pytest.raises(Conflict, match="already has items"):
        inventory.load(db, inventory.read(written(tmp_path, SMALL)), actor)
    assert db.execute("SELECT count(*) FROM events").fetchone()[0] == before


# --- the bundled file -------------------------------------------------------------


def test_the_bundled_file_is_there(db):
    assert inventory.bundled().is_file()

    said = inventory.load(db, inventory.read("demo"), admin(db))

    assert said == "loaded 3 locations, 4 generics with 15 units, 5 single items"
    assert named(db, "Tent, 4-person")["generic"] is True
    assert not any(fields.get("generic") and fields.get("status") for fields in state(db)["item"].values())


def test_every_home_in_the_bundled_file_resolves(db):
    inventory.load(db, inventory.read("demo"), admin(db))
    locations = set(state(db)["location"])

    homes = {fields.get("home_location_id") for fields in state(db)["item"].values()}

    assert homes <= locations


# --- a file that will not do ------------------------------------------------------


def test_a_missing_file(tmp_path):
    with pytest.raises(BadRequest, match="no inventory file at"):
        inventory.read(tmp_path / "nothing.toml")


def test_a_file_that_is_not_toml(tmp_path):
    with pytest.raises(BadRequest, match="not valid TOML"):
        inventory.read(written(tmp_path, "[[items]\nname ="))


def test_a_home_that_is_not_a_location(tmp_path):
    with pytest.raises(BadRequest, match="no location named 'Shed'"):
        inventory.read(
            written(tmp_path, SMALL.replace('home = "Cold locker"\nsub_location', 'home = "Shed"\nsub_location'))
        )


def test_two_units_with_the_same_number(tmp_path):
    with pytest.raises(BadRequest, match="two units with the same number"):
        inventory.read(written(tmp_path, SMALL.replace("number = 2\nnickname", "number = 1\nnickname")))


def test_an_item_with_no_name(tmp_path):
    with pytest.raises(BadRequest, match="name"):
        inventory.read(written(tmp_path, SMALL.replace('name = "Trailer, 5 by 8"', 'name = ""')))


def test_a_mistyped_key(tmp_path):
    with pytest.raises(BadRequest, match="Extra inputs are not permitted"):
        inventory.read(written(tmp_path, SMALL.replace("sub_location = ", "shelf = ")))


# --- from the seed file -----------------------------------------------------------


def seed_file(tmp_path: Path, inventory_line: str) -> Path:
    text = f"""\
{inventory_line}

[admin]
name = "Alex"
email = "alex@example.org"
password = "correct horse"

[group]
name = "10th Richmond"
"""
    return written(tmp_path, text, "seed.toml")


def test_the_seed_file_loads_it_once(db, tmp_path):
    path = seed_file(tmp_path, 'inventory = "demo"')

    done = seed.apply(db, seed.read(path))

    assert done[-1] == "loaded 3 locations, 4 generics with 15 units, 5 single items"
    assert len(state(db)["item"]) == 24

    assert seed.apply(db, seed.read(path)) == []
    assert len(state(db)["item"]) == 24


def test_the_seed_file_can_name_a_file_of_its_own(db, tmp_path):
    mine = written(tmp_path, SMALL, "mine.toml")

    done = seed.apply(db, seed.read(seed_file(tmp_path, f'inventory = "{mine}"')))

    assert done[-1] == "loaded 2 locations, 1 generic with 2 units, 1 single item"


def test_no_inventory_key_loads_nothing(db, tmp_path):
    seed.apply(db, seed.read(seed_file(tmp_path, "# nothing to load")))

    assert state(db).get("item") is None


def test_a_database_with_items_is_left_alone(db, tmp_path):
    """A group that has started using the app does not get demo tents at the next restart."""
    inventory.load(db, inventory.read(written(tmp_path, SMALL)), admin(db))
    before = len(state(db)["item"])

    seed.apply(db, seed.read(seed_file(tmp_path, 'inventory = "demo"')))

    assert len(state(db)["item"]) == before


# --- through the command line -----------------------------------------------------


def test_gear_admin_load(tmp_path, monkeypatch, capsys):
    db_path = tmp_path / "fresh.db"
    with open_db(db_path) as conn:
        from gear_tracker.migrate import migrate

        migrate(db_path)
        accounts.install_admin(conn, "Alex", "alex@example.org", "correct horse")

    code, out, err = run(monkeypatch, capsys, "--db", str(db_path), "load", "--file", "demo")

    assert code == 0, err
    assert out.strip() == "loaded 3 locations, 4 generics with 15 units, 5 single items"

    code, _, err = run(monkeypatch, capsys, "--db", str(db_path), "load", "--file", "demo")
    assert code == 1
    assert "already has items" in err


def test_gear_admin_load_needs_an_admin(tmp_path, monkeypatch, capsys):
    code, _, err = run(monkeypatch, capsys, "--db", str(tmp_path / "g.db"), "load", "--file", "demo")

    assert code == 1
    assert "no Admin" in err


def test_gear_admin_load_as_a_named_admin(tmp_path, monkeypatch, capsys):
    db_path = tmp_path / "fresh.db"
    from gear_tracker.migrate import migrate

    migrate(db_path)
    with open_db(db_path) as conn:
        accounts.install_admin(conn, "Alex", "alex@example.org", "correct horse")
        wanted = accounts.install_admin(conn, "Sam", "sam@example.org", "correct horse")

    code, _, err = run(monkeypatch, capsys, "--db", str(db_path), "load", "--file", "demo", "--as", "sam@example.org")

    assert code == 0, err
    with open_db(db_path) as conn:
        row = conn.execute("SELECT actor_id FROM events WHERE entity_type = 'item' LIMIT 1").fetchone()
        assert row["actor_id"] == wanted


def test_gear_admin_load_with_an_unknown_admin(tmp_path, monkeypatch, capsys):
    code, _, err = run(
        monkeypatch, capsys, "--db", str(tmp_path / "g.db"), "load", "--file", "demo", "--as", "nobody@example.org"
    )

    assert code == 1
    assert "no account for nobody@example.org" in err
