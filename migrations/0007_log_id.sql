-- Which log this is. Set once, when the database is created, and never changed.
--
-- A device sends it back on every pull. A cursor that came from a different log
-- is refused (HTTP 410) instead of being answered with the tail of a log this
-- device has no snapshot for, which is what left screens full of
-- "(unknown item)" after the server database was replaced.
--
-- A restore from backup keeps the id, which is right: same log.

INSERT INTO meta (key, value) VALUES ('log_id', lower(hex(randomblob(16))));
