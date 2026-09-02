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

Deferred until we have Avery 6576 stock. Not blocked on us, and not holding anything up:

- [ ] Confirm the sheet registers on real stock, and record the margins for FR-TAG-02
- [ ] Test through a scuffed sticker and a wet one

## M6 — Items and codes

Built. What is left waits on other work:

- [ ] Filter by condition (FR-INV-08); category joins when categories exist (FR-SET-07)
- [ ] Check the printed sheet against real Avery 6576 stock and fix `labels.py` if the margins are off (FR-TAG-02)

## M7 — Movement

The vertical slice is built. What is left needs a phone.

- [ ] End-to-end test on a real phone with wifi and data turned off

## M9 — Go live

First real use, not the finished release. Musts in repairs, reservations and found gear are still to come in M10-M12;
going live early buys feedback while the inventory is fresh from the labelling walk. MoSCoW priorities say what the
system needs before it is done, not what M9 needs.

- [ ] Put the nightly `gear-backup` in the host's cron, and rehearse a restore once ([deploy.md](deploy.md#restoring))
- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.

## M13 — The rest

Pulled forward only when someone asks for them.

- [ ] Mark an item missing; clears on the next scan (FR-INV-19)
- [ ] Revoke one device without deactivating its account (FR-USR-14)
- [ ] Screen for reviewing queued conflicts (FR-OFF-10)
- [ ] Photos: never cached, captured offline, uploaded at next sync (FR-INV-11); then the photo on a repair ticket
      (FR-REP-01)
- [ ] Purchase date, price, supplier (FR-INV-12)
- [ ] Merge duplicate items, once the append-only design for it is settled (FR-INV-13)
- [ ] Browse by location and sub-location (FR-INV-10)
- [ ] Repair report (FR-RPT-02)
- [ ] Misplaced gear report (FR-RPT-09)
- [ ] Audit history on the item page (FR-USR-09)
- [ ] Accessibility pass to WCAG 2.2 AA (NFR-A11Y-01)
