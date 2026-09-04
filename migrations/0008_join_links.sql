-- A standing link an Admin can hand to a room of volunteers at once, instead of one link per
-- person (FR-USR-19). Server-only, like `links`: the token itself is never stored, only its hash.
-- Unlike `links`, this is not spent by a single redeem — it lives until its chosen expiry, or
-- until an Admin revokes it.
CREATE TABLE join_links (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    created_by  TEXT NOT NULL REFERENCES accounts (user_id),
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked_at  INTEGER
);
