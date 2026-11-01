# Tasks

The build, in order. See [architecture.md](architecture.md) for why, and [stories/](stories/) for what each step is for.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

---

## M6 — Items and codes

Built. What is left waits on other work:

- [ ] Check the printed sheet against the real stock and fix `labels.py` if the margins are off (FR-TAG-02)

## M9 — Go live

First real use. Everything in the requirements that is built is built; going live buys feedback while the inventory is
fresh from the labelling walk.

- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.

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
