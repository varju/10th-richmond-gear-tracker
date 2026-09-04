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

- [ ] Check the printed sheet against real Avery 6576 stock and fix `labels.py` if the margins are off (FR-TAG-02)

## M7 — Movement

The vertical slice is built. What is left needs a phone.

- [ ] End-to-end test on a real phone with wifi and data turned off

## M9 — Go live

First real use. Everything in the requirements that is built is built; going live buys feedback while the inventory is
fresh from the labelling walk.

- [ ] Put the nightly `gear-backup` in the host's cron, and rehearse a restore once ([deploy.md](deploy.md#restoring))
- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.

## M10 — First feedback

From the first volunteers to use it. Fixes first, then features. Where a task changes a requirement, it says so; amend
the row in the same commit.

### Fixes

- [ ] Settings: the Sync now button flickers every 30 s. The poll in `autosync.ts` sets `shell.busy`, which disables the
      button. Only a sync the person started should disable it.
- [ ] Reservations: "Also Fall Camp, …" becomes "Needed for Fall Camp, …", in `reservations.ts`, `conflicts.py`, and the
      reservation page's "Also reserved for". Replay vectors do not carry the string; check before assuming.
- [ ] Scan: a read should look like a read. Pause the video when the card opens and resume it when the card closes, so
      the frame freezes on the sticker. Draw a target box in the viewfinder. Vibrate on a read where the platform
      allows.
- [ ] Install prompt on Android: the note says "Safari" and offers only Not now when `beforeinstallprompt` has not
      fired. Name the browser the person is in. When the event has not fired, show that browser's own steps (Chrome:
      menu, Add to Home screen), not nothing.
- [ ] A used invite or reset link says "this link is not valid". A spent invite should say the account exists and offer
      Sign in; a spent reset should say the same and offer a new reset. Only an expired or unknown link is "not valid".
- [ ] Public page: drop the item name. Show the group name, how to reach us, and the found form (amend FR-PUB-01). A
      finder does not need the name, and a stranger must not learn the inventory by scanning codes.
- [ ] Users: an Admin can change a user's name and email (extend FR-USR-04). Both changes go in the audit log with old
      and new values (FR-USR-05). Email stays unique. The user's open sessions are kept.

### Features

- [ ] Pack from home: under Check out, list reservations that start within seven days; one tap opens Pack. The Pack list
      shows only what is still unpacked, with a toggle to show packed lines as well. New FR-RES row.
- [ ] Join link: an Admin creates a standing join link, shown as a URL and a QR code, with an expiry and a Revoke
      button. Whoever opens it gives a name, email, and password and gets an active User account. Admins see the new
      account in Users. Amend FR-USR-13 to "no sign-up except through a link an Admin issued"; new FR-USR row.
      Per-person one-time links (FR-USR-12) stay for email.
- [ ] Notifications by email: each user ticks categories on their own settings page. Categories: a found report, a new
      repair ticket, a user joined (through the join link or a one-time invite). Sent through the Admin's SMTP account
      (FR-USR-15); nothing is sent when none is set. One mail per event, no digest. New FR row; NFR-SEC-05 is unchanged
      because the preference is a setting, not a field about the person.
- [ ] Calendar feeds: an Admin pastes ICS feed URLs (about four) into Settings. The server refreshes them hourly and
      keeps the upcoming events. Devices receive the event names and dates in sync, so the reservation form and the
      session event field suggest them offline. Feed URLs carry a private token and stay on the server, as the mail
      password does (NFR-SEC-10). New FR-RES row. Do not name the calendar product in docs.
