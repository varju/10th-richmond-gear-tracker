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

- [ ] Several categories per item (FR-SET-07): `category_id` becomes `category_ids`, a list. Touches the filter
      (FR-INV-08), item fields, CSV import and export (FR-SET-11, FR-RPT-03), the audit label, valuation (FR-RPT-06),
      the assistant's `list_categories` and `update_item`, both replays, and `vectors/replay/`. A unit still reads its
      generic's.

## Later — Store wrapper

Not scheduled. Design and gate are in [architecture.md](architecture.md#store-wrapper); the requirement is NFR-DEP-11.
Nothing here starts until M10 feedback shows the home-screen install failing.

- [ ] Capacitor project under `ios/` wrapping the built client, served from the bundle.
- [ ] Camera inside the wrapper: confirm the WebAssembly scanner meets NFR-USE-01 in the WebView, or feed the Capacitor
      camera plugin into the same decode loop.
- [ ] Server keeps sync compatible with the previous store release. Write the rule down and test it.
- [ ] First submission: review note asking for unlisted distribution, and the unlisted request form filed the same day.
      If guideline 4.2 blocks it, delete this section and move NFR-DEP-11 to Won't with the reason.
- [ ] Install link in the Scouter guide beside the home-screen instructions, never replacing them.
