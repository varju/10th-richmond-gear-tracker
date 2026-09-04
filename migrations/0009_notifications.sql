-- Email a person chooses to get for one kind of event (FR-USR-18): a found
-- report, a new repair ticket, a new account. A preference, not a fact about
-- the person, so it sits here rather than on the event log (NFR-SEC-05 is
-- unaffected).
--
-- One row per category a user has turned on; no row means no mail for that
-- category. Updated in place, like mail and devices.
CREATE TABLE notification_prefs (
    user_id  TEXT NOT NULL REFERENCES accounts (user_id),
    category TEXT NOT NULL CHECK (category IN ('found', 'repair', 'joined')),
    PRIMARY KEY (user_id, category)
);
