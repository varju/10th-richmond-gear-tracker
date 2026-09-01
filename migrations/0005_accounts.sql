-- Who can sign in. Server-only: none of this reaches a device.
--
-- The user as a person — name, role, active — is an entity on the event log,
-- so changes to it are audited (FR-USR-05) and nobody is ever removed
-- (FR-USR-06). What is here is the credential side: email, password hash,
-- sessions, and one-time links. Rows here are updated in place; they are not
-- history.

CREATE TABLE accounts (
    user_id       TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT,                     -- NULL until an invite is redeemed
    created_at    INTEGER NOT NULL
);

-- A long-lived token per device (FR-USR-07, FR-USR-08). Stored hashed; the
-- device holds the only copy of the token itself.
CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES accounts (user_id),
    device_id   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    revoked_at  INTEGER
);

CREATE INDEX sessions_user ON sessions (user_id);

-- Invite and reset links (FR-USR-12). One use each.
CREATE TABLE links (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES accounts (user_id),
    kind        TEXT NOT NULL CHECK (kind IN ('invite', 'reset')),
    created_at  INTEGER NOT NULL,
    used_at     INTEGER
);

INSERT INTO meta (key, value) VALUES ('server_seq', '0');
