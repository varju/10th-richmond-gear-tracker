# Tasks

What is next. See [architecture.md](architecture.md) for how it is built, and [stories/](stories/) for how it is used.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

---

## Scanner stops reading with the camera live

Once in the iPhone app, the scan screen showed a live picture but read no codes. Home, then Scan again, fixed it. What
came before is not known; no way to reproduce it yet.

The app scans natively (`ios/App/App/ScannerPlugin.swift`), so the web scanner's suspects do not apply. A code read
found no clear cause. Suspects, most likely first:

1. Focus or zoom stuck: `configure()` limits autofocus to near, and `aim()` zooms up to 3x. A fresh start re-aims, which
   fits Home then Scan fixing it.
2. The picture was frozen, not live: a native pause, or a heat interruption.
3. A stale `rectOfInterest`, if `aim()` ran during an interruption and nothing re-aimed after.
4. An IndexedDB write that never settles: `seen()` in plain mode, or `bindCode` in Scan new code, where `bound.current`
   then drops every code.

**Next:** when it happens again, long-press the viewfinder to show the diagnostics line, and screenshot it before
leaving the screen.

**Considered:** re-run `aim()` on resume and when an interruption ends, and re-trigger focus when nothing is read for a
few seconds. A guess until the diagnostics say which.

## Tidy the desk inventory's filter bar

The desk **Inventory** screen opens with six labelled boxes reading "Any", two checkboxes, two buttons and a row count
before any gear shows.

**Considered:**

- The filters do not line up with the columns below, and two match no column (Shelf; Needs, where the table says Flags).
- Filters as part of the column headers, or the rarer ones (Shelf, Needs, Show retired) under one **More filters**, with
  set filters shown as removable chips.
- "188 rows" could say items, and sit with the table rather than above its header.
- **New item** and **Scan** float on the checkbox row; they could join the header or the actions.
- Files: `ItemTable.tsx`, `Filters.tsx`.

**Deferred because:** wants a design review first. Not urgent.

## Send iPads to the app

Once the App Store has an iPad build, offer it to iPads as to iPhones (NFR-DEP-12). Not before: an iPad sent to the
iPhone-only build loses the Add to Home Screen hint.

- `client/src/lib/install.ts`: `isIos()` also matches iPadOS Safari, which reports `Macintosh` with
  `maxTouchPoints > 1`. Replace `isIphone()` with one that is true for iPhone and iPad, not iPod.
- `InstallPrompt.tsx`: "There’s an iPhone app." becomes wording that fits both. Keep a test that an iPad with no link
  sees the home-screen hint.
- Say iPhone or iPad in NFR-DEP-12, the architecture install notes, the Scouter guide's "Install it", the
  `SettingsGroup.tsx` help text, `docs/deploy.md` and the `iphone_app_url` comment in `inventory.ts`. Fix the
  `iPhone app` regex in the finder test in `App.test.tsx`. Keep the field name.

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

## Drop the workbox-build glob override

`client/package.json` forces glob 14 on workbox-build to patch a minimatch ReDoS. Remove it once workbox-build depends
on glob 14 or later.
