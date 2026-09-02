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

## M9 — Go live

First real use. Everything in the requirements that is built is built; going live buys feedback while the inventory is
fresh from the labelling walk.

- [ ] Put the nightly `gear-backup` in the host's cron, and rehearse a restore once ([deploy.md](deploy.md#restoring))
- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.

## M10 — Structure, before the labelling walk

Categories come first: the walk assigns them, and the export carries them. Nothing here changes replay, so the vectors
stay as they are.

- [ ] Categories (FR-SET-07): a `category` entity on the log, managed in Settings like a location. One `category_id` on
      a single item or a generic; a unit reads its generic's. Delete is blocked while in use (FR-SET-05)
- [ ] The phone list groups rows under category headings, uncategorised last. The desk table gets a sortable Category
      column instead. Category joins the filters (FR-INV-08)
- [ ] New item remembers the last category picked on this device, so a run of tents costs no taps
- [ ] Assistant: `list_categories`, and `category_id` on create_item and update_item (FR-MCP-03)
- [ ] Requirements: FR-SET-07 to Should. Drop the "when it is built" clauses from FR-INV-01 and FR-INV-08. Categories in
      demo.toml
- [ ] Anyone sees the devices their own account is signed in on, in Settings, and revokes one; an Admin still does it
      for anyone (new FR-USR-17; FR-MCP-02 points at it). The device list leaves Users.tsx for a component both screens
      use. The new-token text says to revoke it below, not to ask an Admin
- [ ] Export the inventory as CSV (FR-RPT-03, NFR-DATA-10): every live item, one row each; home and category by name;
      code, status and holder read-only
- [ ] Import the same CSV (new FR-SET-11; FR-SET-08 points at it). A row with an id changes that item; a row without one
      adds an item. A column absent from the file leaves the field alone; a blank cell clears it. A location or category
      name not yet known is created. All or nothing, with errors by row number. Preview, then Apply, in Settings. The
      server writes the events as the Admin
- [ ] `gear-admin export` and `gear-admin import`: the same module from the keyboard
- [ ] The scan screen takes a mode, `/scan?mode=out` or `mode=in`, switchable on the screen. A scan that agrees with the
      mode keeps one tap (FR-OUT-03). One that disagrees warns instead of flipping: "Already in. Nothing to do", or who
      has it with Transfer to me as the primary action (FR-OUT-12). The other direction stays on the card as a plain
      secondary button. A plain `/scan` behaves as today, for the desk table and old links
- [ ] Home offers Take out and Bring back in place of Scan. Bring back shows no session event; packing a reservation
      opens in Take out. Rewrite FR-OUT-06: the mode sets the default, and a scan that disagrees with it warns
- [ ] The desk table shows every unit indented under its generic, always. The disclosure triangle goes
- [ ] A subtle link to the source, https://github.com/varju/10th-richmond-gear-tracker, at the foot of Settings
- [ ] Record in architecture.md why sync polls rather than holding a socket open
