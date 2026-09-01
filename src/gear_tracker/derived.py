"""The derived-state cache: keeping it current, and rebuilding it when in doubt."""

from __future__ import annotations

import json
import sqlite3

from gear_tracker.events import in_replay_order
from gear_tracker.replay import State, replay


def refresh_entity(conn: sqlite3.Connection, entity_type: str, entity_id: str, seq: int) -> None:
    """Re-derive one entity from its slice of the log. Runs inside append's transaction.

    A whole-entity replay rather than an incremental apply, because the new
    event is not always the last one in replay order: a phone that syncs on
    Sunday delivers Friday's events into the middle of the history.
    """
    state = replay(in_replay_order(conn, entity_type, entity_id))
    fields = state.get(entity_type, {}).get(entity_id, {})
    conn.execute(
        "INSERT OR REPLACE INTO entities (entity_type, entity_id, state) VALUES (?, ?, ?)",
        (entity_type, entity_id, json.dumps(fields, sort_keys=True)),
    )
    conn.execute("UPDATE meta SET value = max(CAST(value AS INTEGER), ?) WHERE key = 'derived_seq'", (seq,))


def rebuild(conn: sqlite3.Connection) -> int:
    """Throw the cache away and replay everything. Returns the number of entities."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM entities")
        state = replay(in_replay_order(conn))
        rows = [
            (entity_type, entity_id, json.dumps(fields, sort_keys=True))
            for entity_type, by_id in state.items()
            for entity_id, fields in by_id.items()
        ]
        conn.executemany("INSERT INTO entities (entity_type, entity_id, state) VALUES (?, ?, ?)", rows)
        last = conn.execute("SELECT coalesce(max(seq), 0) FROM events").fetchone()[0]
        conn.execute("UPDATE meta SET value = ? WHERE key = 'derived_seq'", (str(last),))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return len(rows)


def snapshot(conn: sqlite3.Connection) -> State:
    """Everything the cache holds, in the same shape replay() returns."""
    state: State = {}
    for row in conn.execute("SELECT entity_type, entity_id, state FROM entities"):
        state.setdefault(row["entity_type"], {})[row["entity_id"]] = json.loads(row["state"])
    return state


def cursor(conn: sqlite3.Connection) -> int:
    """The event seq the cache is true at."""
    return int(conn.execute("SELECT value FROM meta WHERE key = 'derived_seq'").fetchone()[0])
