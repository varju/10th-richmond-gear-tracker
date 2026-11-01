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
