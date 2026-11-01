# Tasks

What is next. See [architecture.md](architecture.md) for how it is built, and [stories/](stories/) for how it is used.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

---

## Reservations follow-ups

- [ ] **Consider calling reservations "events".** People think in events (Apple Day, Fall camp), and the event question
      already uses the word. Decide first, then rename the UI words, help and docs only. Keep `reservation` in code,
      event types, payloads (`reservation_id`), the API, and FR-RES IDs: older app builds sync on those names. Keep
      `/reservations` URLs working (redirect if renamed). Watch for clashes with "event" meaning a log event in docs,
      and with the session event.

## Tests

- [ ] Fix the flaky `test_deleting_an_item_releases_its_codes` in `tests/test_assistant.py`. It failed once in a full
      run (a released code still showed as bound), then passed five reruns. Likely cause: events written in the same
      millisecond replay out of order.
- [ ] Fix the flaky "Only new ones leaves the earlier moves as they were (FR-OUT-40)" in
      `client/src/ui/ScanMove.test.tsx`. It failed once in a full run, then passed three runs on its own and two more
      full runs. Cause not yet known.

## Groups of items

- [ ] Question to consider: How to better manage our PFD collection. We have several bags, grouped by size. e.g. Adult
      (paddling), Adult, Youth 60-90, Youth 30-60. Most of the time an entire bag is signed out at once. Occasionally a
      single PFD will be borrowed from within a bag. So the bags are both a storage location and an item that can be
      checked out. Another example of the same scenario a canoe trailer is both storage and an item.

## UI

- [ ] Inventory screen has a lot of vertical padding. Use space better on desktop? Also Consider allowing generics to be
      collapsed.
- [ ] As quartermaster, how can I find items that have no QR code, or that have no location or shelf set?
- [ ] Status column is blank for countables, with actual status on next line. Why?
