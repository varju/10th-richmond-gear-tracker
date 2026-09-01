"""Versioned SQL migrations, run on deploy (NFR-MAINT-07).

Migrations are plain `.sql` files named `NNNN_description.sql`. They run once
each, in ascending order, and each one is applied atomically together with the
record that it ran. A migration that fails leaves the database untouched.

Migrations must not manage their own transactions; the runner does that.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from gear_tracker.db import open_db

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"
FILENAME = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")

SCHEMA_MIGRATIONS = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
)
"""


class MigrationError(RuntimeError):
    """Something is wrong with the migrations themselves, not the database."""


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    path: Path

    @property
    def label(self) -> str:
        return f"{self.version:04d}_{self.name}"


def discover(directory: Path) -> list[Migration]:
    """Read the migration files, rejecting anything ambiguous."""
    if not directory.is_dir():
        raise MigrationError(f"No migrations directory at {directory}")

    found: dict[int, Migration] = {}
    for path in sorted(directory.glob("*.sql")):
        match = FILENAME.match(path.name)
        if not match:
            raise MigrationError(f"Bad migration filename: {path.name} (want NNNN_lower_snake.sql)")
        version = int(match.group(1))
        if version in found:
            raise MigrationError(f"Two migrations share version {version:04d}: {found[version].path.name}, {path.name}")
        found[version] = Migration(version, match.group(2), path)
    return [found[v] for v in sorted(found)]


def applied(conn: sqlite3.Connection) -> dict[int, str]:
    conn.execute(SCHEMA_MIGRATIONS)
    rows = conn.execute("SELECT version, name FROM schema_migrations ORDER BY version").fetchall()
    return {row["version"]: row["name"] for row in rows}


def pending(conn: sqlite3.Connection, directory: Path) -> list[Migration]:
    """Migrations not yet run, checked for the two ways this goes wrong."""
    done = applied(conn)
    on_disk = discover(directory)
    known = {m.version for m in on_disk}

    missing = sorted(set(done) - known)
    if missing:
        raise MigrationError(
            f"Database has migrations that are not on disk: {', '.join(f'{v:04d}' for v in missing)}. "
            "The checkout is probably older than the database."
        )

    todo = [m for m in on_disk if m.version not in done]
    if todo and done:
        highest = max(done)
        stale = [m for m in todo if m.version < highest]
        if stale:
            raise MigrationError(
                f"Migration {stale[0].label} is numbered below {highest:04d}, which has already run. "
                "Renumber it above the highest applied version."
            )
    return todo


def apply(conn: sqlite3.Connection, migration: Migration) -> None:
    """Run one migration and record it, both or neither.

    executescript() commits any open transaction before it runs, so the
    transaction has to live inside the script rather than around it.
    """
    sql = migration.path.read_text()
    name = migration.name.replace("'", "''")
    now = datetime.now(UTC).isoformat(timespec="seconds")
    script = (
        "BEGIN;\n"
        f"{sql}\n;\n"
        "INSERT INTO schema_migrations (version, name, applied_at) "
        f"VALUES ({migration.version}, '{name}', '{now}');\n"
        "COMMIT;"
    )
    try:
        conn.executescript(script)
    except sqlite3.Error:
        # Not executescript: that commits a pending transaction before running,
        # which would keep exactly the half-applied migration we are discarding.
        conn.execute("ROLLBACK")
        raise


def migrate(db_path: str | Path, directory: Path = MIGRATIONS_DIR, dry_run: bool = False) -> list[Migration]:
    """Bring a database up to date. Returns what ran, or what would run."""
    with open_db(db_path) as conn:
        todo = pending(conn, directory)
        if dry_run:
            return todo
        for migration in todo:
            apply(conn, migration)
        return todo


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bring a Gear Tracker database up to date.")
    parser.add_argument("--db", required=True, help="path to the SQLite file")
    parser.add_argument("--dir", type=Path, default=MIGRATIONS_DIR, help="migrations directory")
    parser.add_argument("--dry-run", action="store_true", help="say what would run, change nothing")
    args = parser.parse_args(argv)

    try:
        ran = migrate(args.db, args.dir, args.dry_run)
    except MigrationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if not ran:
        print("Up to date.")
    elif args.dry_run:
        print(f"Would apply {len(ran)}:")
        for m in ran:
            print(f"  {m.label}")
    else:
        for m in ran:
            print(f"applied {m.label}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
