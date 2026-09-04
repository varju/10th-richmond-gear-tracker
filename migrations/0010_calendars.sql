-- Calendar feeds an Admin points at the group's own calendar, so upcoming
-- events can be offered as the reservation event name (calendars.py).
--
-- Server-only, like the mail account (migration 0006): a feed URL can carry a
-- private token, so it stays here, never on the event log, and never reaches
-- a device (NFR-SEC-10). An Admin sees it redacted to host and path.
CREATE TABLE calendar_feeds (
    id              TEXT PRIMARY KEY,
    url             TEXT NOT NULL,
    label           TEXT NOT NULL DEFAULT '',
    added_at        INTEGER NOT NULL,
    last_fetched_at INTEGER,
    last_error      TEXT
);

-- Events kept from a feed's last successful fetch: 7 days ago to 180 days
-- ahead. Replaced whole on every successful fetch; a failed one leaves these
-- as they were. Not events on the log -- reference data the server owns and
-- ships to devices through sync.
--
-- starts and ends are calendar dates, "YYYY-MM-DD", where the group is
-- (NFR-DATA-12), matching how a reservation stores its own dates. A recurring
-- event expands to one row per occurrence in the window, so the same uid can
-- appear more than once with different dates.
CREATE TABLE calendar_events (
    feed_id TEXT NOT NULL REFERENCES calendar_feeds (id) ON DELETE CASCADE,
    uid     TEXT NOT NULL,
    summary TEXT NOT NULL,
    starts  TEXT NOT NULL,
    ends    TEXT NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (feed_id, uid, starts)
);
