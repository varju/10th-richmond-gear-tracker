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

## M2 — The event log

The core of the system. Get this right before anything is built on it.

- [ ] Test fixture: a migrated SQLite file per test under `tmp_path`, real database, no mocks
- [ ] `events` table: id, entity_type, entity_id, type, actor, device, device_seq, occurred_at, clock_offset,
      effective_at, received_at, seq, payload
- [ ] Every entity that changes offline is on this log: items, users, locations, codes, reservations, tickets, settings
- [ ] Event ids are ULIDs, unique per event, so push is idempotent
- [ ] `seq` assigned by the server inside the insert transaction; it is the sync cursor
- [ ] Clamp `occurred_at + clock_offset` on arrival into `effective_at`: never after `received_at`, never before the
      previous event from the same device
- [ ] Replay order is `(effective_at, device_id, device_seq)`, total and stable
- [ ] Append-only enforcement: no update or delete path exists
- [ ] Derived state built by replaying the log
- [ ] Rebuild-from-log routine, and a test that proves derived state matches a fresh replay
- [ ] Shared JSON test vectors: events in, derived state out. The Python and TypeScript suites both run them
      (NFR-MAINT-04)

## M3 — Sync

- [ ] `GET /sync/bootstrap`: current state plus the cursor it was true at (FR-OFF-14)
- [ ] Every sync response carries `server_time`; the client stores the measured clock offset (NFR-DATA-13)
- [ ] Events are stamped with the offset in force when they were recorded, beside the raw device time
- [ ] A fresh offset far from the stored one flags events recorded under the old estimate
- [ ] Test: a device 3 hours fast, syncing 2 days later, still records the right time
- [ ] `POST /sync/push`, idempotent on event id, batched, returning accepted and rejected with reasons
- [ ] `GET /sync/pull?since=<cursor>`, cursor over `seq`, exclusive, ordered by `seq`
- [ ] A cursor the server cannot honour returns "re-bootstrap", not silence
- [ ] Devices keep a snapshot plus the last 90 days; unsent events are never trimmed (NFR-DATA-03)
- [ ] Test: two devices append offline to the same item, both land, neither is lost (FR-OFF-05)
- [ ] Test: the same push replayed twice changes nothing
- [ ] Test: a deactivated account's pending push is accepted, attributed, and is the last thing it can do (FR-OFF-06)
- [ ] Test: an event committing out of timestamp order is still delivered by the `seq` cursor
- [ ] Test: bootstrap includes an item last touched two years ago
- [ ] Two check-outs of one item, different devices, no check-in between: queued, not guessed (FR-OFF-10)

## M4 — Accounts

- [ ] First Admin created from the command line at install; no open sign-up (FR-USR-13)
- [ ] Sign in with email and password, hashed with argon2 (NFR-SEC-02)
- [ ] Invites and password resets are one-time links; the server sends no email (FR-USR-12)
- [ ] Sign-in exchanged once for a long-lived local token; sessions never expire (FR-USR-07, FR-USR-08)
- [ ] Two roles, Admin and User (FR-USR-02)
- [ ] Invite, deactivate, change role (FR-USR-04)
- [ ] The last Admin cannot be demoted or deactivated (FR-USR-03)
- [ ] User and role changes write audit events (FR-USR-05)
- [ ] Deactivation does not remove anyone from the log (FR-USR-06)

## M5 — The client shell

- [ ] TypeScript PWA that installs to a home screen (NFR-DEP-01, NFR-DEP-06)
- [ ] Request persistent storage; tell the user if it is refused (NFR-DATA-11)
- [ ] Prompt to install, and explain why: an uninstalled tab loses unsent work after 7 days on iOS
- [ ] Bootstrap on first run, then pull; replay shared with the server via the M2 test vectors
- [ ] Service worker caches the app shell; cold start under 3 seconds offline (NFR-PERF-03)
- [ ] IndexedDB persistence; full item set held in memory (NFR-PERF-07)
- [ ] Sync on app open, on regaining connectivity, and after every movement (FR-OFF-03)
- [ ] Persistent unsent-count banner on every screen (FR-OFF-04)
- [ ] Records pending more than 3 days interrupt on open (FR-OFF-09)
- [ ] Dark, gloved, one-handed layout: 44 px targets, actions in the lower half (NFR-USE-03)

## M6 — Items and codes

Scanning tasks here reuse the camera and decode loop proven in M0.

- [ ] Storage locations: create, rename, reassign items between them (FR-SET-01, FR-SET-02)
- [ ] Deleting a location still in use is blocked, and names what blocks it (FR-SET-05)
- [ ] Free-form sub-location label on an item; no list, no hierarchy (FR-SET-03, FR-SET-04)
- [ ] Item CRUD with retire and unretire (FR-INV-01, FR-INV-04, FR-INV-05)
- [ ] Date added and date modified, set by the system (FR-INV-03)
- [ ] Search as you type over 500 items, under 200 ms (FR-INV-07, NFR-PERF-01)
- [ ] Filter by category, location, sub-location, condition, status (FR-INV-08)
- [ ] Code lifecycle: unassigned, assigned, replaced; codes are random and never reused (FR-TAG-05, NFR-SEC-04)
- [ ] Scanning an assigned code opens its item (FR-TAG-06)
- [ ] Scanning an unassigned code offers create-or-bind (FR-TAG-07)
- [ ] Assign a replacement code to an item with a lost sticker (FR-TAG-04)
- [ ] PDF sheet of unassigned codes for Avery 6576 (FR-TAG-02, FR-TAG-03)

## M7 — Movement

The vertical slice. After this the system is usable for its main purpose.

- [ ] Scanning is contextual: out means check in, in means check out (FR-OUT-06)
- [ ] One scan, one tap; scanner stays live between items (FR-OUT-03, NFR-USE-02)
- [ ] Session event set once, applied until changed (FR-OUT-05)
- [ ] Check in and out by search for unlabelled gear (FR-OUT-02, FR-OUT-07)
- [ ] Anyone can check in anyone's gear (FR-OUT-08)
- [ ] Check-in shows the item's home (FR-OUT-10)
- [ ] Edit any field from the check-in screen (FR-OUT-11)
- [ ] Already-out gear shows the holder and offers transfer (FR-OUT-12)
- [ ] Per-movement notes, correctable by appending (FR-OUT-13, FR-OUT-15, FR-OUT-16)
- [ ] End-to-end test on a real phone, in a real locker, with no signal

## M8 — The first report

- [ ] What is out and who has it (FR-RPT-01)
- [ ] Gear out longer than the group-wide period (FR-OUT-14, FR-RPT-05)

## M9 — Go live

First real use, not the finished release. Musts in repairs, reservations and found gear are still to come in M10-M12;
going live early buys feedback while the inventory is fresh from the labelling walk. MoSCoW priorities say what the
system needs before it is done, not what M9 needs.

- [ ] Point the group's domain at the server (NFR-DEP-09)
- [ ] Deploy to the home server behind an outbound tunnel (NFR-DEP-05)
- [ ] HTTPS (NFR-SEC-01)
- [ ] Nightly backup of the SQLite file, off the machine, kept 30 days (NFR-DATA-05, NFR-DATA-06)
- [ ] Restore tested and written down (NFR-DATA-07)
- [ ] Document how to move the server to another house (NFR-MAINT-05)
- [ ] Public item page: name, group name, contact route, nothing else (FR-PUB-01, NFR-SEC-03)
- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.

## M10 — Repairs

- [ ] Raise a ticket against an item, with optional photo (FR-REP-01, FR-REP-02)
- [ ] States: open, in progress, resolved, won't fix (FR-REP-03)
- [ ] Open tickets flagged in lists and at check-out (FR-REP-05)
- [ ] Free-form comments, editable through the repair (FR-REP-06)
- [ ] Raise a ticket from the check-in screen (FR-OUT-09)
- [ ] History stays on the item after close (FR-REP-04)

## M11 — Reservations

- [ ] Create a reservation: event name, dates, items (FR-RES-01)
- [ ] Check-out starts a seeded scanning session (FR-RES-02)
- [ ] Event name inherited from the reservation (FR-RES-03)
- [ ] Unscanned items named at finish, not blocked (FR-RES-04)
- [ ] Unlisted scans append silently (FR-RES-07)
- [ ] Conflicting reservations named (FR-RES-05)
- [ ] Duplicate a reservation (FR-RES-10)

## M12 — Found gear

- [ ] Found-gear form with note and optional contact (FR-PUB-02)
- [ ] Reports reach the Quartermaster in the app (FR-PUB-03)
- [ ] Rate limiting and spam resistance (FR-PUB-04)

## M13 — The rest

Pulled forward only when someone asks for them.

- [ ] Mark an item missing; clears on the next scan (FR-INV-19)
- [ ] Revoke one device without deactivating its account (FR-USR-14)
- [ ] Screen for reviewing queued conflicts (FR-OFF-10)
- [ ] Photos: never cached, captured offline, uploaded at next sync (FR-INV-11)
- [ ] Purchase date, price, supplier (FR-INV-12)
- [ ] Merge duplicate items, once the append-only design for it is settled (FR-INV-13)
- [ ] Browse by location and sub-location (FR-INV-10)
- [ ] Repair report (FR-RPT-02)
- [ ] Misplaced gear report (FR-RPT-09)
- [ ] Audit history on the item page (FR-USR-09)
- [ ] Accessibility pass to WCAG 2.2 AA (NFR-A11Y-01)
