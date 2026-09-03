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

## M20 — Second round of phone feedback

From using the app at 10thrichmond.ca/gear. Fixes first, then wording, then the screens. Answers to the open questions
are folded into each task.

### History and repairs

- [ ] History lists newest first, so a new note lands at the top while Add note sits at the foot. Add note moves to just
      under the History heading, above the list.
- [ ] A repair ticket says "Raised by Alice · 2026-09-01 14:32" on every device. Today the name comes from the `created`
      event, which a phone that started from a snapshot does not hold, so it says "Raised". Replay records the raiser on
      the ticket (`raised_by`) in both languages, with a vector; the label reads it, and shows the minute like History
      does. The Repairs list's "raised <date>" matches.

### Settings

- [ ] Drop the Help link at the foot of Settings; Help is in the menu. Help's back button goes home.
- [ ] Settings shows the build's git short hash, beside the Source link at the foot. The client build has no `.git`
      (`.dockerignore` drops it), so `make image` passes it as a build arg (`GIT_SHA`, from
      `git rev-parse --short     HEAD`) that the Dockerfile hands to `npm run build`, and `vite.config.ts` bakes it in
      with `define`. A local `npm     run dev` shows "dev" when it is unset. The hash links to the commit on GitHub.

### Items

- [ ] The Categories fieldset on the item form starts closed. Its summary names the ticked categories, or says "None".
- [ ] Search matches the name only (FR-INV-07), and a unit's number and nickname. The home location no longer matches,
      so "Home" or a location's name does not pull in everything that lives there.
- [ ] A generic with one unit can become a single item again, the reverse of FR-INV-26. Anyone signed in may do it, from
      the generic's page. The unit keeps its id, code and history; takes the generic's name, description, categories,
      home and purchase details; drops its number, and its nickname goes onto the end of the description. The generic is
      marked merged into the unit, like a duplicate record (FR-INV-13), so its photos and record stay readable. Add
      FR-INV-33 (Should) for it, and a replay vector.

## M9 — Go live

First real use. Everything in the requirements that is built is built; going live buys feedback while the inventory is
fresh from the labelling walk.

- [ ] Put the nightly `gear-backup` in the host's cron, and rehearse a restore once ([deploy.md](deploy.md#restoring))
- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.
