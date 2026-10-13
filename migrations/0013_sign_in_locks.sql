-- Wrong passwords per email, and the lock they lead to (NFR-SEC-12, NFR-SEC-13). Keyed by the
-- email as typed, lowercased, not by account: an email with no account counts and locks the same
-- way, so a lock says nothing about whether the account exists. Server-only, like `accounts`.
CREATE TABLE sign_in_locks (
    email          TEXT PRIMARY KEY,
    failures       INTEGER NOT NULL,  -- wrong passwords since the last lock or right password
    locks          INTEGER NOT NULL,  -- locks so far; each doubles the wait
    locked_until   INTEGER,           -- ms; refused until then
    last_failed_at INTEGER NOT NULL
);

-- What the pruning of forgotten rows reads.
CREATE INDEX sign_in_locks_last_failed_at ON sign_in_locks (last_failed_at);
