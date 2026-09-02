-- How the server sends mail (FR-USR-15). Optional: with no row here nothing is
-- sent, and an invite or reset link is copied out of the app by hand, which is
-- how the group worked before this existed.
--
-- Server-only, like accounts. The SMTP password is the one secret that cannot
-- be hashed, because SMTP AUTH needs it in the clear. Keeping it here rather
-- than on the event log is what stops it reaching twenty phones.
--
-- One row, id 1. Updated in place; this is not history.
CREATE TABLE mail (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    host         TEXT NOT NULL,
    port         INTEGER NOT NULL,
    encryption   TEXT NOT NULL CHECK (encryption IN ('none', 'starttls', 'ssl')),
    username     TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    from_address TEXT NOT NULL,
    updated_at   INTEGER NOT NULL
);
