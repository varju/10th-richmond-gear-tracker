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

## M22 — Third round of feedback

### Assistant

- [ ] Admin tools over MCP (FR-MCP-10). Each Admin action the app has gets a tool, refused for a User's token with the
      same reason the app gives: users (invite, reset link, deactivate, change role), anyone's devices, mail settings
      and the test message, group settings, locations and categories (add, rename, delete), a sheet of codes, CSV export
      and import with the preview, delete an item, merge and unmerge duplicates. Reuse the server functions the app's
      endpoints call; no second code path. The server's MCP instructions and the "Connect an assistant" text in Settings
      stop saying Admin work is out of reach. Guide section "assistant.md" follows.

### Reservations

- [ ] Reservation form: one search adds gear. A unit never matches; its generic does. A single item is added as itself.
      A generic (or pool) row carries a quantity the person adjusts in the list, default 1, so the separate "so many of
      a generic" select and quantity control go. Units already on a reservation (scanned on, FR-RES-07) still show and
      can be removed.
- [ ] Reservation shows who created it (FR-RES-18). A derived `created_by` on the reservation, set at replay from the
      creating event's actor the way `raised_by` is on a repair; in `DERIVED_FIELDS`, both replays, and a vector. The
      reservation page and `get_reservation` show "Added by <name>, <date and time>".
- [ ] Item page shows upcoming reservations (FR-INV-37). A "Reserved" block under the status: one line per reservation
      that names the item, or its generic, and has not ended: event, dates, each a link to the reservation. Nothing
      shown when there are none. `get_item` reports the same.

### Item page

- [ ] "Mark missing…" and "Delete for good…" leave the item page's footer and sit at the bottom of the Edit screen,
      below Save, with the same two-tap confirms and the same gating (Admin, in, not retired). The generic page moves
      its Delete the same way. The footer keeps the everyday actions only.

## M9 — Go live

First real use. Everything in the requirements that is built is built; going live buys feedback while the inventory is
fresh from the labelling walk.

- [ ] Put the nightly `gear-backup` in the host's cron, and rehearse a restore once ([deploy.md](deploy.md#restoring))
- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.

## M21 — Counted pools

Bowls, plates, cups: a stack we count, not twenty stickers. FR-INV-34 to 36, FR-OUT-22 to 24, FR-RPT-11, FR-MCP-08, and
the pool clauses in FR-RES-13 and FR-RES-15. Queued behind go-live.

- [ ] Event log. `checked_out` and `checked_in` on a pool carry `count`; a `recounted` event carries `count` and
      `reason`. Validate in `events.py`. Replay in both languages: out by holder is checkouts minus returns, never below
      zero; in is the last recount, or the starting quantity, plus returns minus checkouts since; owned is in plus out.
      Vectors: two devices check out offline and both land; a recount; a return of fewer than were taken; an overdraw.
- [ ] Server rules. A pool takes no units and no code; binding one or adding a unit is refused with a reason. A count
      below one is refused.
- [ ] New item. "We have several of these" offers two kinds: labelled one by one (units, as today) or a stack we count,
      with a quantity. A single item can become a pool the way it becomes a generic (FR-INV-26), keeping its record.
- [ ] Pool page. Owned, in, and out by holder (FR-INV-36). Check out asks how many, default 1, with the event line
      (FR-OUT-22). Return offers what the person has out to confirm or change (FR-OUT-23). Recount asks for the count
      and a reason (FR-INV-35). Overdraw warns in the notice style repair warnings use.
- [ ] Lists and reports. The list row shows in and out counts; What is out lists a pool once per holder with its count
      (FR-RPT-11); the item's History shows counts on each line.
- [ ] Reservations. Reserve a quantity of a pool (FR-RES-13); the clash rule counts against quantity owned (FR-RES-15);
      checking out from the reservation page takes a count and ticks it off.
- [ ] CSV. Export carries a pool's quantity, in, and out; import creates a pool from a row with a quantity.
- [ ] Assistant. `check_out`, `check_in` and `get_item` per FR-MCP-08; `search_items` says a pool is one.
- [ ] Guide. A Scouter task "Take some of a stack" and a Quartermaster task "Recount a stack".
