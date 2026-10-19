# Tasks

The build, in order. See [architecture.md](architecture.md) for why, and [stories/](stories/) for what each step is for.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

Milestones are ordered by risk, not by feature value. M0 comes first because a bad result there changes the project.

---

## M0 — Prove the scanner

Passed indoors on two iPhones: worst single acquisition 1.58 s against a 2 s bar, no camera dropouts. Numbers are in
[architecture.md](architecture.md#what-m0-measured). What is left needs a locker, or label stock.

- [ ] Repeat in an unlit locker, and with gloves on
- [ ] Add those numbers to architecture.md

Deferred until the first sheet is printed on real stock (32 labels of 1.75 x 1.25 in). Not blocked on us, and not
holding anything up:

- [ ] Confirm the sheet registers on real stock, and record the margins for FR-TAG-02
- [ ] Test through a scuffed sticker and a wet one

## M6 — Items and codes

Built. What is left waits on other work:

- [ ] Check the printed sheet against the real stock and fix `labels.py` if the margins are off (FR-TAG-02)

## M9 — Go live

First real use. Everything in the requirements that is built is built; going live buys feedback while the inventory is
fresh from the labelling walk.

- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.

## M11 — iPhone app

- [ ] Time the [native scanner](architecture.md#native-scanner) in the app against the M0 table and its 2 s bar
- [ ] Submit for App Review, with a note asking for unlisted distribution
- [ ] Send the unlisted distribution request form

## Reservations follow-ups

- [ ] **Consider calling reservations "events".** People think in events (Apple Day, Fall camp), and the event question
      already uses the word. Decide first, then rename the UI words, help and docs only. Keep `reservation` in code,
      event types, payloads (`reservation_id`), the API, and FR-RES IDs: older app builds sync on those names. Keep
      `/reservations` URLs working (redirect if renamed). Watch for clashes with "event" meaning a log event in docs,
      and with the session event.
