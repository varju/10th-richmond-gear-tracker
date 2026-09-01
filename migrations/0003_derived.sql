-- Derived state: a cache of what the log says right now, one row per entity.
--
-- Rebuild it from the log at any time (gear_tracker.derived.rebuild). Nothing
-- writes here except replay, and replay only runs inside the transaction that
-- appended the event it is reacting to. meta.derived_seq is the last event
-- seq the cache accounts for; bootstrap hands that to the device as its cursor.

CREATE TABLE entities (
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (json_type(state) = 'object'),
    PRIMARY KEY (entity_type, entity_id)
);

INSERT INTO meta (key, value) VALUES ('derived_seq', '0');
