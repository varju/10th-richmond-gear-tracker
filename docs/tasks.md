# Tasks

What is next. See [architecture.md](architecture.md) for how it is built, and [stories/](stories/) for how it is used.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

---

## Canoe trailer as storage

A canoe trailer is both storage and an item that can be checked out. Today its contents still show as in at the yard
when the trailer is out.

**Considered:** nothing yet beyond the question.

**Deferred because:** wait until the group has used pools for PFD bags.

## QR code when adding a unit

Offer to put a QR code on a new unit straight away. It is the likely next step and seems to cost too many taps.

**Considered:**

- It is already two taps: **Add a unit**, then **Add QR code**. A prompt on the new unit's page is easier to spot but
  saves no taps.
- Fewer taps means opening the scanner straight after adding, with a way to skip, or a second "Add a unit and scan"
  button.
- Scanning an unassigned sticker and picking **Add a unit of…** already does both in one step.

**Deferred because:** waiting on more user testing.

## Compare with a past event

"What did I miss compared to event X?" Compare what is out for this event with a past one, to spot forgotten gear.

**Considered:**

- **Compare with…** on an event's page lists what went out for the past event but not yet for this one, from the
  movement log by event name and dates.
- `compare_events` in `assistant.py`. Needs a requirement.
- Open question: compare a generic's units by count, or unit by unit.

**Deferred because:** not given.

## Check-out order on an event's gear list

Offer check-out order as a sort option on an event's gear list, which is now alphabetical.

**Considered:** a **Sort** switch on the event page, Name or Checked out, remembered per phone.

**Deferred because:** wait until someone asks for it.

## Fewer buttons for beginners

Some Scouters only want to check gear in and out, and do not need the gear-management actions.

**Considered:**

- Tidy for everyone, not a mode or a role. Each screen keeps everyday actions in view; rare ones go under one **More…**,
  shut by default.
- Research plan: 1. count the live log's event types; 2. mark each item-page action everyday or rare; 3. watch two or
  three Scouters on a Friday night for what the log cannot show (searches, filters, screens opened and left, taps
  cancelled); 4. tidy. No tap tracking.
- Steps 1 and 2 are done (log from 2026-09-02 to 2026-11-02, 2,313 events):
  - One Admin made 95% of them, mostly setup: 1,075 field changes (home 288, category 236, name 179, merge 119, delete
    79, number and parent 122) and 788 created (479 items, 256 codes).
  - Users made 50 events in all, almost only check-outs (18) and QR codes (14).
  - Moves: 145 check-outs, 71 check-ins, 67 event corrections, 42 gear-list additions. Only 18 check-out runs (2 to 4
    within 10 s) suggest the scanner.
  - Rare: recount 8, photos 7, notes 5, cleaning 5.
  - Everyday on an item page: check out, check in, change event, add QR code. Rare: edit, recount, photos, notes, send
    home with, merge, several of these, single item, counted stack, duplicate, delete.

When analyzing data, note that the admin is a power user, and isn't representative of most users.

**Deferred because:** the log says little about Users yet. Watch two or three Scouters (step 3) before tidying.

## Better use of photos

Show a photo during check-out to confirm the right item, and use a lone photo as the item's thumbnail.

**Considered:** the offline copy carries one small thumbnail per item (the first photo unless one is picked; a unit
falls back to its generic's), shown on the scan card, the item page and the list. Needs FR-INV-11 reworded.

**Deferred because:** photos are online only (FR-INV-11), so a photo at check-out in a locker would mostly fail to load.

## Audit log: link to the item

In an expanded row, link to the item if it still exists.
