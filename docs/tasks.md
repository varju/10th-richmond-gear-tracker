# Tasks

The build, in order. See [architecture.md](architecture.md) for why, and [stories/](stories/) for what each step is for.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

Milestones are ordered by risk, not by feature value. M0 comes first because a bad result there changes the project.

---

## M0 — Prove the scanner

Nothing else matters if a phone cannot decode a QR code fast enough in a dark locker. Build the smallest thing that
answers that.

- [ ] Throwaway page: open the camera, decode a QR code with a WebAssembly decoder, show the result
- [ ] Print a test sheet of codes on Avery 6576 stock
- [ ] Measure decode time on the oldest iPhone we can borrow, indoors and in a dark locker
- [ ] Measure ten consecutive scans without tearing down the camera between them
- [ ] Test through a scuffed sticker and a wet one
- [ ] Write the result into architecture.md, including the numbers

**Stop and reconsider if:** a single scan takes more than about two seconds, or the camera cannot stay alive between
scans. NFR-USE-01 and NFR-USE-02 are unreachable without both.

## M1 — Foundations

- [ ] Repository, licence, README, `.gitignore`
- [ ] Python project with dependency management and a formatter
- [ ] One command sets up a dev environment on a clean machine (NFR-MAINT-03)
- [ ] CI runs tests on every pull request (NFR-MAINT-06)
- [ ] SQLite schema and a migration tool (NFR-MAINT-07)
- [ ] Vulnerability scan on dependencies in CI (NFR-SEC-09)

## M2 — The event log

The core of the system. Get this right before anything is built on it.

- [ ] `events` table: id, item_id, type, actor, device, occurred_at, received_at, payload
- [ ] Event ids are ULIDs generated on the device, so push is idempotent
- [ ] Append-only enforcement: no update or delete path exists
- [ ] Derived state built by replaying the log
- [ ] Rebuild-from-log routine, and a test that proves derived state matches a fresh replay
- [ ] Tests for the movement event types (NFR-MAINT-04)

## M3 — Sync

- [ ] `POST /sync/push`, idempotent on event id, batched
- [ ] `GET /sync/pull?since=<cursor>`, cursor over received_at
- [ ] Devices receive only the last 90 days (NFR-DATA-03)
- [ ] Test: two devices append offline to the same item, both land, neither is lost (FR-OFF-05)
- [ ] Test: the same push replayed twice changes nothing
- [ ] Test: a deactivated account's pending push is accepted and attributed (FR-OFF-06)
- [ ] Conflicts a machine cannot settle are queued rather than guessed (FR-OFF-10)

## M4 — Accounts

- [ ] Sign in with email and password, hashed with argon2 (NFR-SEC-02)
- [ ] Sign-in exchanged once for a long-lived local token; sessions never expire (FR-USR-07, FR-USR-08)
- [ ] Two roles, Admin and User (FR-USR-02)
- [ ] Invite, deactivate, change role (FR-USR-04)
- [ ] The last Admin cannot be demoted or deactivated (FR-USR-03)
- [ ] User and role changes write audit events (FR-USR-05)
- [ ] Deactivation does not remove anyone from the log (FR-USR-06)

## M5 — The client shell

- [ ] TypeScript PWA that installs to a home screen (NFR-DEP-01, NFR-DEP-06)
- [ ] Service worker caches the app shell; cold start under 3 seconds offline (NFR-PERF-03)
- [ ] IndexedDB persistence; full item set held in memory (NFR-PERF-07)
- [ ] Sync on app open, on regaining connectivity, and after every movement (FR-OFF-03)
- [ ] Persistent unsent-count banner on every screen (FR-OFF-04)
- [ ] Escalate records pending more than a few days (FR-OFF-09)
- [ ] Dark, gloved, one-handed layout: 44 px targets, actions in the lower half (NFR-USE-03)

## M6 — Items and codes

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

The system is usable at this point. Everything after M9 is improvement.

- [ ] Deploy to the home server behind an outbound tunnel (NFR-DEP-05)
- [ ] HTTPS (NFR-SEC-01)
- [ ] Nightly backup of the SQLite file, off the machine, kept 30 days (NFR-DATA-05, NFR-DATA-06)
- [ ] Restore tested and written down (NFR-DATA-07)
- [ ] Document how to move the server to another house (NFR-MAINT-05)
- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

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

## M12 — Public pages

- [ ] Public item page: item name, group name, contact route, nothing else (FR-PUB-01, NFR-SEC-03)
- [ ] Found-gear form with note and optional contact (FR-PUB-02)
- [ ] Reports reach the Quartermaster in the app (FR-PUB-03)
- [ ] Rate limiting and spam resistance (FR-PUB-04)

## M13 — The rest

Pulled forward only when someone asks for them.

- [ ] Photos on items and tickets, server-only (FR-INV-11)
- [ ] Purchase date, price, supplier (FR-INV-12)
- [ ] Merge duplicate items (FR-INV-13)
- [ ] Browse by location and sub-location (FR-INV-10)
- [ ] Repair report (FR-RPT-02)
- [ ] Misplaced gear report (FR-RPT-09)
- [ ] Audit history on the item page (FR-USR-09)
- [ ] Accessibility pass to WCAG 2.2 AA (NFR-A11Y-01)
