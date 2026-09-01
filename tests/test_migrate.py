"""The migration runner has to be trustworthy before anything sits on it."""

from __future__ import annotations

import sqlite3

import pytest

from gear_tracker.db import open_db
from gear_tracker.migrate import MigrationError, discover, migrate, pending
from tests.conftest import write


def test_applies_in_order(tmp_path, migrations):
    write(migrations, "0001_first.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY)")
    write(migrations, "0002_second.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY)")

    ran = migrate(tmp_path / "g.db", migrations)

    assert [m.label for m in ran] == ["0001_first", "0002_second"]
    with open_db(tmp_path / "g.db") as conn:
        names = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"a", "b", "schema_migrations"} <= names


def test_running_twice_changes_nothing(tmp_path, migrations):
    write(migrations, "0001_first.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY)")
    db = tmp_path / "g.db"

    assert len(migrate(db, migrations)) == 1
    assert migrate(db, migrations) == []


def test_dry_run_applies_nothing(tmp_path, migrations):
    write(migrations, "0001_first.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY)")
    db = tmp_path / "g.db"

    todo = migrate(db, migrations, dry_run=True)

    assert [m.label for m in todo] == ["0001_first"]
    with open_db(db) as conn:
        tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "a" not in tables


def test_a_failed_migration_leaves_nothing_behind(tmp_path, migrations):
    write(migrations, "0001_first.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY)")
    # Valid first statement, broken second: the table must not survive either.
    write(
        migrations,
        "0002_broken.sql",
        "CREATE TABLE b (id INTEGER PRIMARY KEY);\nINSERT INTO no_such_table VALUES (1);",
    )
    db = tmp_path / "g.db"

    with pytest.raises(sqlite3.Error):
        migrate(db, migrations)

    with open_db(db) as conn:
        tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "a" in tables, "the migration that succeeded should stand"
        assert "b" not in tables, "the failed migration must roll back"
        versions = [r["version"] for r in conn.execute("SELECT version FROM schema_migrations")]
        assert versions == [1], "a failed migration must not be recorded"


def test_recovers_after_a_failure(tmp_path, migrations):
    write(migrations, "0001_broken.sql", "THIS IS NOT SQL;")
    db = tmp_path / "g.db"
    with pytest.raises(sqlite3.Error):
        migrate(db, migrations)

    # Fix the migration and try again; the runner must not be wedged.
    write(migrations, "0001_broken.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY)")
    assert [m.label for m in migrate(db, migrations)] == ["0001_broken"]


def test_rejects_duplicate_versions(migrations):
    write(migrations, "0001_one.sql", "SELECT 1")
    write(migrations, "0001_two.sql", "SELECT 1")

    with pytest.raises(MigrationError, match="share version 0001"):
        discover(migrations)


def test_rejects_bad_filenames(migrations):
    write(migrations, "nope.sql", "SELECT 1")

    with pytest.raises(MigrationError, match="Bad migration filename"):
        discover(migrations)


def test_rejects_a_migration_slipped_in_below_one_already_run(tmp_path, migrations):
    write(migrations, "0002_second.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY)")
    db = tmp_path / "g.db"
    migrate(db, migrations)

    # Someone merges a branch numbered below what has already shipped.
    write(migrations, "0001_first.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY)")
    with open_db(db) as conn, pytest.raises(MigrationError, match="numbered below"):
        pending(conn, migrations)


def test_rejects_a_database_ahead_of_the_checkout(tmp_path, migrations):
    write(migrations, "0001_first.sql", "CREATE TABLE a (id INTEGER PRIMARY KEY)")
    write(migrations, "0002_second.sql", "CREATE TABLE b (id INTEGER PRIMARY KEY)")
    db = tmp_path / "g.db"
    migrate(db, migrations)

    (migrations / "0002_second.sql").unlink()
    with open_db(db) as conn, pytest.raises(MigrationError, match="not on disk"):
        pending(conn, migrations)


def test_the_real_migrations_apply(tmp_path):
    """The migrations we actually ship must run on an empty database."""
    ran = migrate(tmp_path / "real.db")

    assert ran, "expected at least one shipped migration"
    with open_db(tmp_path / "real.db") as conn:
        assert conn.execute("SELECT value FROM meta WHERE key='schema_created_by'").fetchone()[0] == "gear-tracker"
