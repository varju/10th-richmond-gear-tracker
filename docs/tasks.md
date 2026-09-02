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

- [ ] Category joins the filters when categories exist (FR-INV-08, FR-SET-07)
- [ ] Check the printed sheet against real Avery 6576 stock and fix `labels.py` if the margins are off (FR-TAG-02)

## M7 — Movement

The vertical slice is built. What is left needs a phone.

- [ ] End-to-end test on a real phone with wifi and data turned off

## M14 — First-look feedback

A read-through of the built app. Everything here is small except the mail server.

Item page:

- [ ] Notes should be deletable

Desktop, for work at a table rather than a locker:

- [ ] A layout for wide screens
- [ ] Every section reachable from the home screen, reports and users included

Mail:

- [ ] SMTP settings an Admin fills in, kept server-side, with a test send
- [ ] Send invites and reset links by mail when it is configured; the copyable link stays

Deployment:

- [ ] Cap the request body on the /gear/ proxy so a photo fits and nothing else does

## M9 — Go live

First real use. Everything in the requirements that is built is built; going live buys feedback while the inventory is
fresh from the labelling walk.

- [ ] Put the nightly `gear-backup` in the host's cron, and rehearse a restore once ([deploy.md](deploy.md#restoring))
- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.
