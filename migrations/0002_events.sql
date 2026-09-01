-- The event log. See docs/architecture.md, "The event log".
--
-- Timestamps are integer milliseconds since the Unix epoch, UTC. Integers
-- sort and subtract without a parser, and both replays (Python here,
-- TypeScript on the device) read them the same way.
--
-- seq is the sync cursor. AUTOINCREMENT makes it monotonic and never reused,
-- even across a restore. SQLite has one writer at a time, so seq order is
-- commit order, which is what makes it safe to page over.
--
-- The allowed entity and event types are not CHECK constraints. They grow
-- with the product, and SQLite cannot alter a CHECK without rebuilding the
-- table. gear_tracker.events validates them on the way in.

CREATE TABLE events (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT    NOT NULL UNIQUE,
    entity_type  TEXT    NOT NULL,
    entity_id    TEXT    NOT NULL,
    type         TEXT    NOT NULL,
    actor_id     TEXT    NOT NULL,
    device_id    TEXT    NOT NULL,
    device_seq   INTEGER NOT NULL CHECK (device_seq >= 1),
    occurred_at  INTEGER NOT NULL,
    clock_offset INTEGER NOT NULL,
    effective_at INTEGER NOT NULL,
    received_at  INTEGER NOT NULL,
    payload      TEXT    NOT NULL CHECK (json_type(payload) = 'object'),
    UNIQUE (device_id, device_seq)
);

CREATE INDEX events_replay ON events (effective_at, device_id, device_seq);
CREATE INDEX events_entity ON events (entity_type, entity_id);

-- Append-only (NFR-DATA-02). Not a convention: the database refuses.
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
    SELECT RAISE(ABORT, 'events is append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
    SELECT RAISE(ABORT, 'events is append-only');
END;
