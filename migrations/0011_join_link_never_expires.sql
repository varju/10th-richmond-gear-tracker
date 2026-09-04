-- Let a standing join link be created with no expiry: NULL means it never expires on its own,
-- only by revocation. SQLite has no ALTER COLUMN, so the table is rebuilt to drop the NOT NULL.
ALTER TABLE join_links RENAME TO join_links_old;

CREATE TABLE join_links (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    created_by  TEXT NOT NULL REFERENCES accounts (user_id),
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER,
    revoked_at  INTEGER
);

INSERT INTO join_links SELECT * FROM join_links_old;

DROP TABLE join_links_old;
