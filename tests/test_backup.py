"""Snapshots against real SQLite files, including one being written to."""

from __future__ import annotations

import gzip
import os
import time
from pathlib import Path

import pytest

from gear_tracker import backup, events
from gear_tracker.db import open_db

DAY = 86400


def restore(archive: Path, to: Path) -> Path:
    """What docs/deploy.md tells a volunteer to do, as a function."""
    with gzip.open(archive, "rb") as raw:
        to.write_bytes(raw.read())
    return to


def test_a_snapshot_restores_to_the_same_events(db_path, tmp_path):
    with open_db(db_path) as conn:
        for i in range(3):
            events.append_server(conn, "alice", "item", f"item-{i}", "created", {"name": f"Tent {i}"})

    archive = backup.backup(db_path, tmp_path / "backups")
    assert archive.name.startswith("gear-") and archive.name.endswith(".db.gz")

    restored = restore(archive, tmp_path / "restored.db")
    with open_db(restored) as conn:
        names = [row["entity_id"] for row in conn.execute("SELECT entity_id FROM events ORDER BY seq")]
    assert names == ["item-0", "item-1", "item-2"]


def test_a_snapshot_is_consistent_while_the_server_is_writing(db_path, tmp_path):
    """The reason this is not `cp`: an open write transaction is not in the snapshot, and the file is not torn."""
    with open_db(db_path) as writing:
        events.append_server(writing, "alice", "item", "item-1", "created", {"name": "Tent"})
        writing.execute("BEGIN IMMEDIATE")
        writing.execute("INSERT INTO meta (key, value) VALUES ('half_written', '1')")

        archive = backup.backup(db_path, tmp_path / "backups")
        writing.execute("ROLLBACK")

    restored = restore(archive, tmp_path / "restored.db")
    with open_db(restored) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert [row["entity_id"] for row in conn.execute("SELECT entity_id FROM events")] == ["item-1"]
        assert conn.execute("SELECT count(*) FROM meta WHERE key = 'half_written'").fetchone()[0] == 0


def test_thirty_days_are_kept_and_older_ones_go(db_path, tmp_path):
    into = tmp_path / "backups"
    into.mkdir()
    now = time.time()
    ages = {"gear-2026-07-01.db.gz": 40, "gear-2026-08-20.db.gz": 12, "gear-2026-08-31.db.gz": 1}
    for name, days in ages.items():
        (into / name).write_bytes(b"old")
        os.utime(into / name, (now - days * DAY, now - days * DAY))

    backup.backup(db_path, into, now=now)

    kept = sorted(p.name for p in into.glob("gear-*.db.gz"))
    assert "gear-2026-07-01.db.gz" not in kept
    assert "gear-2026-08-20.db.gz" in kept
    assert "gear-2026-08-31.db.gz" in kept
    assert len(kept) == 3  # two survivors and today's


def test_nothing_half_written_is_left_behind(db_path, tmp_path):
    into = tmp_path / "backups"
    backup.backup(db_path, into)
    assert [p.name for p in into.iterdir() if p.suffix == ".part"] == []


def test_a_corrupt_database_is_reported_not_archived(db_path, tmp_path):
    """Scribble over a page. SQLite refuses it, and no archive is written to be trusted later."""
    raw = bytearray(db_path.read_bytes())
    raw[4096:4496] = b"A" * 400
    db_path.write_bytes(bytes(raw))

    with pytest.raises(backup.Corrupt):
        backup.backup(db_path, tmp_path / "backups")
    assert list((tmp_path / "backups").glob("*.db.gz")) == []


def test_the_command_says_so_rather_than_raising(db_path, tmp_path, capsys):
    raw = bytearray(db_path.read_bytes())
    raw[4096:4496] = b"A" * 400
    db_path.write_bytes(bytes(raw))

    assert backup.main(["--db", str(db_path), "--into", str(tmp_path / "backups")]) == 1
    assert "malformed" in capsys.readouterr().err


def test_the_command_prints_where_it_wrote(db_path, tmp_path, capsys):
    assert backup.main(["--db", str(db_path), "--into", str(tmp_path / "backups")]) == 0
    written = Path(capsys.readouterr().out.strip())
    assert written.exists()
