"""gear-backup: a consistent copy of the database, kept for thirty days.

`cp gear.db` is not a backup. In WAL mode the file on disk is half the story
until a checkpoint lands, and a copy taken mid-write restores as a corrupt
database. SQLite's online backup API takes a consistent snapshot while the
server keeps serving, which is what this runs (NFR-DATA-05).

Writing the snapshot beside the database is only the first half. A copy on the
same box is not a backup (NFR-DATA-06); something on the host has to carry the
directory off the machine. See docs/deploy.md.
"""

from __future__ import annotations

import argparse
import gzip
import shutil
import sqlite3
import sys
import time
from pathlib import Path

KEEP_DAYS = 30
"""How long snapshots are kept (NFR-DATA-05). Older ones are deleted as each new one is written."""

PREFIX = "gear-"
SUFFIX = ".db.gz"


class Corrupt(RuntimeError):
    """SQLite would not copy the database, or would not vouch for the copy.

    Heard nightly rather than at a restore, which is the whole point of
    checking (NFR-DATA-07).
    """


def backup(db: str | Path, into: str | Path, keep_days: int = KEEP_DAYS, now: float | None = None) -> Path:
    """Snapshot `db` into `into`, gzipped and dated. Returns the file written."""
    now = time.time() if now is None else now
    into = Path(into)
    into.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d", time.gmtime(now))
    target = into / f"{PREFIX}{stamp}{SUFFIX}"
    plain = into / f"{PREFIX}{stamp}.db.part"
    zipped = into / f"{PREFIX}{stamp}{SUFFIX}.part"

    try:
        source = sqlite3.connect(db)
        try:
            snapshot = sqlite3.connect(plain)
            try:
                # Both steps speak the same way when a page is wrong: they raise.
                # A logically broken database, whose pages copy cleanly, is what
                # the check is here for.
                source.backup(snapshot)
                result = snapshot.execute("PRAGMA integrity_check").fetchone()[0]
            except sqlite3.DatabaseError as exc:
                raise Corrupt(f"{db}: {exc}") from exc
            finally:
                snapshot.close()
            if result != "ok":
                raise Corrupt(f"{db}: {result}")
        finally:
            source.close()

        with plain.open("rb") as raw, gzip.open(zipped, "wb") as out:
            shutil.copyfileobj(raw, out)
        # The rename is the last step, so nothing half-written ever carries a
        # name a restore would reach for.
        zipped.replace(target)
    finally:
        plain.unlink(missing_ok=True)
        zipped.unlink(missing_ok=True)

    prune(into, keep_days, now)
    return target


def prune(into: Path, keep_days: int, now: float) -> list[Path]:
    """Delete snapshots older than `keep_days`. Returns what went."""
    cutoff = now - keep_days * 86400
    gone = []
    for old in sorted(into.glob(f"{PREFIX}*{SUFFIX}")):
        if old.stat().st_mtime < cutoff:
            old.unlink()
            gone.append(old)
    return gone


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gear-backup", description="Snapshot the Gear Tracker database.")
    parser.add_argument("--db", required=True, help="path to the SQLite file")
    parser.add_argument("--into", required=True, help="directory to write the snapshot into")
    parser.add_argument("--keep", type=int, default=KEEP_DAYS, help=f"days to keep (default {KEEP_DAYS})")
    args = parser.parse_args(argv)
    try:
        print(backup(args.db, args.into, args.keep))
    except Corrupt as exc:
        # Cron mails this. A traceback would say the same thing at ten times the length.
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
