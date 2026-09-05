-- What a standing join link is for, in an Admin's own words (FR-USR-21): "Beaver leaders",
-- "September open house". Empty means unlabelled, which is what every existing link becomes.
ALTER TABLE join_links ADD COLUMN label TEXT NOT NULL DEFAULT '';
