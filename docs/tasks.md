# Tasks

What is next. See [architecture.md](architecture.md) for how it is built, and [stories/](stories/) for how it is used.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

---

## Record each device's client version

Know which client builds still sync, so an old API shape is dropped only once no device uses it.

- The client sends a version header on every request: its git commit (`__GIT_SHA__`, already in both builds), plus the
  app version and build in the iPhone app, from `appVersion()` in `client/src/lib/appVersion.ts`.
- Add the header to CORS `allow_headers` in `GearApp.build_middleware_stack` in `src/gear_tracker/app.py`, with a test
  from `capacitor://localhost`. Deploy the server before any app build sends it: a preflight naming an unknown header
  fails every request from the app.
- The server keeps the latest version and when it was seen on the session row of the token used. Write only when the
  version changes or last seen is over a day old: `accounts.authenticate` is a read today, and a write per request takes
  SQLite's write lock. Migration 0014.
- Old builds send nothing and show as unknown; assistant sessions show nothing.
- Show it per device in the devices lists (most recently seen row per device) and in `list_devices`.
- New Admin tool `client_versions` in `assistant.py`: each version with its device count and last seen, across all
  users. Add FR-MCP rows for it and for `list_devices`.
- A requirement. Check whether `src/gear_tracker/privacy.py` needs a line.
- Client change: add a line to `docs/pending-ios.md`.

## Tell devices apart on Your devices

**Your devices** lists each sign-in as "Device · signed in <date>". A lost phone can't be told from an old laptop
browser. The `sessions` table keeps only `device_id` and `created_at`.

- At sign-in, keep a short label on the session row, such as "iPhone app", "iPad app", "Safari on iPhone" or "Chrome on
  Mac". Build it from the User-Agent, and from the app's version header (see Record each device's client version). Keep
  the label only, not the raw User-Agent; check `src/gear_tracker/privacy.py`. Sessions from before this show "Device".
- Show when each device was last seen beside when it signed in, and sort by last seen. The client-version task adds that
  column.
- The same in an Admin's view of a user's devices, and in `list_devices`.
- Do it with Record each device's client version, or right after it: they touch the same row and can share
  migration 0014.

**Considered:**

- Let a person name a device. Costs taps; the label covers most cases.
- Sign out devices not seen for some months. The list in testing had 13 rows, most likely dead browsers.

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

**Next:** a hidden diagnostics line on the scan screen (long-press the viewfinder) to screenshot next time: plugin state
(scanning, paused, running, interrupted, `rectOfInterest`, zoom, lens position, focus adjusting, codes seen and dropped)
and JS state (codes received and dropped, `cardOpen`, `cardItem`, `bound`, a `handle` still waiting).

**Considered:** re-run `aim()` on resume and when an interruption ends, and re-trigger focus when nothing is read for a
few seconds. A guess until the diagnostics say which.

## Check out first, ask the event after

The first check-out of a plain session asks "Which event?" before it moves anything. Scouters miss that it must be
answered, and walk off with nothing recorded.

- The first check-out moves at once, with no event. A take-over or transfer moves at once and keeps the event and
  reservation the gear was already out under (as the cleaner branch of `transfer()` does), so nothing drops off an
  event's list.
- A strip then asks "Which event?" with Last used, today's calendar events, a typed name, and **No event**. **Create**
  and **No event** are equal answers, both styled as primary. No Cancel: the move is done, and Return undoes a
  check-out.
- An answer does what an answer given first does today (`planned()` in `client/src/lib/movement.ts`): find or make the
  reservation, correct each waiting move to it by id with `correctEvent`, and join its gear list (FR-OUT-45, FR-RES-38).
  `changeEvent` is not enough: it does not relink a move no reservation took. The session then uses the answer.
- Waiting moves are held by movement id in `meta`, so the strip survives leaving the screen and a restart. They lapse
  with the session, four hours after the last move (FR-OUT-38); a no-event move must now start or extend the session. A
  waiting move since returned or taken over by someone else is dropped from the list.
- On the scan screen the strip is the `SessionEvent` bar above the viewfinder while unanswered, not a second control. On
  item pages it sits above the actions. **Change** there or on **Events** (FR-OUT-43) while moves wait counts as the
  answer.
- Pools follow the same rule: `PoolActions` in `ItemPage.tsx` has its own `useEventQuestion`.
- Ignoring the strip loses only the event, never the move.
- Files: `EventChoice.tsx`, `MoveActions.tsx`, `Scan.tsx`, `ItemPage.tsx`, `client/src/lib/session.ts`,
  `client/src/lib/store.ts`, `client/src/lib/movement.ts`. Reservation sessions are unchanged: they know their event.
- Requirements: reword FR-OUT-05, FR-OUT-37, FR-OUT-38, FR-OUT-44 (the first confirmation names no event), and FR-OUT-41
  / FR-RES-40 for the relink. The assistant's `check_out` already takes the event up front.
- Docs: "The first check-out asks for the event" and the pool line in `docs/guide/scouter.md`; the session paragraph in
  `docs/architecture.md`.
- Client change: add a line to `docs/pending-ios.md`.

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
