-- Feeds are fetched over https only (NFR-SEC-28). The next refresh shows whether the host serves it.
UPDATE calendar_feeds SET url = 'https://' || substr(url, 8) WHERE url LIKE 'http://%';
