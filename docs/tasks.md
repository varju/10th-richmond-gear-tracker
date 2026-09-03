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

Notes from the first week on a phone. Each task stands alone. Categories is the one that changes the schema, so it goes
last.

- [ ] Home search on the phone: move the search box out of the actions into the top of the body, under the header, with
      results listed below it. Take out, Bring back and New item stay at the thumb (NFR-USE-03). With the keyboard open,
      typing must not scroll the box or the results out of view. Test on a phone.
- [ ] Phone menu: replace the ⚙ corner button and the More fold on Home with one ☰ button opening a list: All items,
      Reports, Stock check, Browse by location, Users (admin only), Settings, Help, Sign out. The "N items out" link
      leaves Home. The desk sidebar in `Sections` is unchanged.
- [ ] Reports page at `/reports`: links to What is out, Needs repair and Reservations, with the counts the sidebar shows
      today. On the phone these three are reached only through it. The desk sidebar is unchanged.
- [ ] Item page: History and Changes show the minute (`localMinute`), not the bare date. Added and Modified keep the
      date.
- [ ] Item page: History and Changes fold by default, on phone and desk, as `<details>` with the count in the summary.
- [ ] Item page: Changes names the category. `audit.ts` gets a `category_id` label and `describeValue` resolves it with
      `categoryName`. Check the other id fields while there.
- [ ] Item page: Edit is full width. Under it, on its own line and minor: "Add QR code" when `codesFor` is empty,
      "Replace QR code" when it is not. Same scan flow either way.
- [ ] Rename "Report a fault" to "Report a problem" everywhere a person reads it: buttons, guide pages, stories. Not
      code identifiers.
- [ ] iOS home-screen title still says "Gear" after sign-in and sync, though the manifest says "10th Richmond Gear".
      Safari reads `apple-mobile-web-app-title` at page load, before the client sets it. Have the server rewrite that
      tag in index.html the way it rewrites the manifest, so a signed-out install gets the group name too. Confirm on a
      phone.
- [ ] Several categories per item (FR-SET-07): `category_id` becomes `category_ids`, a list. Touches the filter
      (FR-INV-08), item fields, CSV import and export (FR-SET-11, FR-RPT-03), the audit label, valuation (FR-RPT-06),
      the assistant's `list_categories` and `update_item`, both replays, and `vectors/replay/`. A unit still reads its
      generic's.
