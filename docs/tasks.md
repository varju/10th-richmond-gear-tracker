# Tasks

What is next. See [architecture.md](architecture.md) for how it is built, and [stories/](stories/) for how it is used.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

---

## Keep an event page's filter on Back

On a past event, tick **Not returned**, open an item, tap Back: the box is clear again.

- `ReservationPage.tsx` holds `notPacked` and `mode` in plain `useState`. Keep both in the history entry with
  `entryState` and `setEntryState` from `client/src/lib/router.ts`, as `ItemTable.tsx` does.
- Back, forward and reload restore them; opening the event afresh starts clear.
- Client change: add a line to `docs/pending-ios.md`.

## Search button in the top bar

Off Home, searching takes two taps: ⌂, then the search box. Add a magnifying glass to the top bar that goes Home with
the search box focused.

- `client/src/ui/Page.tsx`: on the right, just left of ☰, where apps usually put search. ⌂ and ‹ stay on the left as
  navigation. Shown when ⌂ is (phone layout, off Home). An inline SVG in the header's colour, not an emoji.
- In the tap handler, `flushSync(() => navigate("/"))`, then focus Home's search box. The focus is inside the tap, so
  iOS raises the keyboard, and nothing is stored, so Back and reload do not refocus. Check on an iPhone, in Safari and
  in the app.
- Check whether ⌂ loses an unsaved draft without asking. Search does what ⌂ does; if ⌂ loses drafts, fix both.
- Add a requirement.
- Client change: add a line to `docs/pending-ios.md`.

## Open a counted line from an event's gear list

On an event's gear list, a line like "3 × Fire trays — 2 not returned" cannot be tapped, unlike the named items above
it. Checking those in means finding the item another way.

- `ReservationPage.tsx`: make each line in the `names` list a button to `/items/<id>`, styled like the `items` list.
  Name "3 × Fire trays"; detail line "2 packed" or "2 not returned", as the line reads today. The packing **Check out**
  box stays as its own control on the row. Update `Reservations.test.tsx`, which pins today's text.
- Same for both modes and for every such line: counted stacks and generics with units.
- A generic's page does not say which of its units are out under this event. Out of scope here.
- Shares `ReservationPage.tsx` with "Keep an event page's filter on Back": do them one after the other.
- Client change: add a line to `docs/pending-ios.md`.

## Always ask a weighed item's weight at check-in

Returning a weighed item sometimes asks its weight and sometimes does not, which looks like the scanner and the item
page differ. Both use `MoveActions.tsx`; the question is skipped when the item was weighed or refilled since it went out
(FR-INV-71). Ask every time, with three answers:

- A weight, as now.
- **Keep**, showing the last reading as typed, with its unit (e.g. "Keep 18 lb"), or "Keep Full" after **Refilled**.
  Offered whenever there is a reading, even one from before the item went out. Keep records a `weighed` event with that
  value, so the reading is current again. The main button when offered: a Scouter with no scale taps it, not Unknown.
- **Unknown**, which records `weighed` with no value and clears what is left, as Unknown on **Weigh** does (FR-INV-70).

Both reuse `weighed`, so replay and `vectors/replay/` are unchanged. Pools are not weighed. **It is back** on the
Conflicts screen (`Conflicts.tsx`) asks too, like any return.

- Requirements: move FR-INV-71 and FR-INV-72 to Won't, each saying what replaced it: Keep now guards a reading taken at
  camp, the reason 7fd7686 made Unknown keep it. Add rows for Keep and for Unknown at check-in.
- Assistant: `check_in`'s `weight_unknown` records `weighed` with no value again (7fd7686 made it record nothing). Add a
  `keep` option. Update FR-MCP-45.
- Guides: the weight sections of `docs/guide/scouter.md` and `docs/guide/quartermaster.md`.
- `docs/pending-ios.md`: replace the unreleased lines "Return skips the weight question…" and "Unknown at check-in
  leaves the last weight as it was", don't append.
- Shares `MoveActions.tsx` with "Check out first, ask the event after": do them one after the other.

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
- Requirements: reword FR-OUT-05, FR-OUT-37, FR-OUT-38, FR-OUT-44 (the first
  confirmation names no event), and FR-OUT-41 / FR-RES-40 for the relink. The assistant's `check_out` already takes the
  event up front.
- Docs: "The first check-out asks for the event" and the pool line in `docs/guide/scouter.md`; the session paragraph in
  `docs/architecture.md`.
- Client change: add a line to `docs/pending-ios.md`.

## Focus the event name on New event

Tapping **New event** on Events opens the form with nothing focused, so it takes another tap to start typing.

- Focus the **Event** field in `ReservationForm.tsx` for a new event only, not on Edit. Focusing it also opens its
  suggestions, so today's calendar events show at once.
- iOS raises the keyboard only for a focus inside the tap, so `autoFocus` alone may not do it. Do as "Search button in
  the top bar" does: in the **New event** handler in `Reservations.tsx`, `flushSync(() => navigate("/events/new"))`,
  then focus the field. Check on an iPhone, in Safari and in the app.
- Client change: add a line to `docs/pending-ios.md`.

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
