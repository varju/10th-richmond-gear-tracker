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

The vertical slice is built. What is left needs a phone and a locker.

- [ ] End-to-end test on a real phone, in a real locker, with no signal
- [ ] The status label reads "In" on the scan card and "in" on the item page; pick one

## M8 — The first report

- [ ] What is out and who has it (FR-RPT-01)
- [ ] Gear out longer than the group-wide period (FR-OUT-14, FR-RPT-05)

## M9 — Go live

First real use, not the finished release. Musts in repairs, reservations and found gear are still to come in M10-M12;
going live early buys feedback while the inventory is fresh from the labelling walk. MoSCoW priorities say what the
system needs before it is done, not what M9 needs.

- [ ] Point the group's domain at the server (NFR-DEP-09)
- [ ] Replace the placeholder app icons in `client/public/`
- [ ] Deploy to the home server behind an outbound tunnel (NFR-DEP-05)
- [ ] HTTPS (NFR-SEC-01)
- [ ] Nightly backup of the SQLite file, off the machine, kept 30 days (NFR-DATA-05, NFR-DATA-06)
- [ ] Restore tested and written down (NFR-DATA-07)
- [ ] Document how to move the server to another house (NFR-MAINT-05)
- [ ] Public item page: name, group name, contact route, nothing else (FR-PUB-01, NFR-SEC-03)
- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.

## M10 — Repairs

- [ ] Raise a ticket against an item, with optional photo (FR-REP-01, FR-REP-02)
- [ ] States: open, in progress, resolved, won't fix (FR-REP-03)
- [ ] Open tickets flagged in lists and at check-out (FR-REP-05)
- [ ] Free-form comments, editable through the repair (FR-REP-06)
- [ ] Raise a ticket from the check-in screen (FR-OUT-09)
- [ ] History stays on the item after close (FR-REP-04)

## M11 — Reservations

- [ ] Create a reservation: event name, dates, items (FR-RES-01)
- [ ] Check-out starts a seeded scanning session (FR-RES-02)
- [ ] Event name inherited from the reservation (FR-RES-03)
- [ ] Unscanned items named at finish, not blocked (FR-RES-04)
- [ ] Unlisted scans append silently (FR-RES-07)
- [ ] Conflicting reservations named (FR-RES-05)
- [ ] Duplicate a reservation (FR-RES-10)
- [ ] Reserve a quantity of a type; any item of the type ticks it off at check-out (FR-RES-13)
- [ ] A type reservation conflicts when demand exceeds the unretired items of that type (FR-RES-15)

## M12 — Found gear

- [ ] Found-gear form with note and optional contact (FR-PUB-02)
- [ ] Reports reach the Quartermaster in the app (FR-PUB-03)
- [ ] Rate limiting and spam resistance (FR-PUB-04)

## M13 — The rest

Pulled forward only when someone asks for them.

- [ ] Mark an item missing; clears on the next scan (FR-INV-19)
- [ ] Revoke one device without deactivating its account (FR-USR-14)
- [ ] Screen for reviewing queued conflicts (FR-OFF-10)
- [ ] Photos: never cached, captured offline, uploaded at next sync (FR-INV-11)
- [ ] Purchase date, price, supplier (FR-INV-12)
- [ ] Merge duplicate items, once the append-only design for it is settled (FR-INV-13)
- [ ] Browse by location and sub-location (FR-INV-10)
- [ ] Repair report (FR-RPT-02)
- [ ] Misplaced gear report (FR-RPT-09)
- [ ] Audit history on the item page (FR-USR-09)
- [ ] Accessibility pass to WCAG 2.2 AA (NFR-A11Y-01)
