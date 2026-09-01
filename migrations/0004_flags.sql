-- Things a person needs to look at: an event recorded under a clock estimate
-- that turned out wrong, and later, whatever else the machine will not guess at.
--
-- This is a work queue, not history. History is the event log.

CREATE TABLE flags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   TEXT    NOT NULL REFERENCES events (id),
    kind       TEXT    NOT NULL,
    detail     TEXT    NOT NULL CHECK (json_type(detail) = 'object'),
    created_at INTEGER NOT NULL
);

CREATE INDEX flags_event ON flags (event_id);
