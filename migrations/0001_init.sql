-- The event log and everything derived from it arrive in M2. This first
-- migration exists so the runner has something real to apply, and so a fresh
-- database records what built it.

CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO meta (key, value) VALUES ('schema_created_by', 'gear-tracker');
