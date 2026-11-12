-- What each session last said about its device (FR-USR-32, FR-USR-33, FR-USR-34, NFR-DEP-16). Set at sign-in,
-- then rewritten only when the version changes or last_seen_at is a day old, so most requests stay
-- reads. Sessions from before this have NULLs until their next request.
ALTER TABLE sessions ADD COLUMN label TEXT;           -- "Safari on iPhone"; never the raw User-Agent
ALTER TABLE sessions ADD COLUMN client_version TEXT;  -- the X-Gear-Client header; NULL from older app builds
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
