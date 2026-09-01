# Architecture

How Gear Tracker is built, and why. Requirements live in [requirements/](requirements/).

The server is small. The client is where the work is.

## Stack

| Layer    | Choice                 | Why                                                                                 |
| -------- | ---------------------- | ----------------------------------------------------------------------------------- |
| Backend  | Python                 | The maintainer's strongest language. Nothing in the requirements argues against it. |
| Database | SQLite                 | One file. Backups and moving house become a file copy (NFR-DATA-06, NFR-MAINT-05).  |
| API      | HTTP + JSON            | Two endpoints carry the sync. No schema layer worth its weight at this size.        |
| Client   | TypeScript PWA         | The only way to meet NFR-DEP-01 without an app store.                               |
| Local    | IndexedDB              | Persistence only. Not a query engine; see [In memory](#in-memory).                  |
| Scanning | WebAssembly QR decoder | iOS has no platform API; see [Scanning](#scanning).                                 |
| Labels   | Server-rendered PDF    | Printing needs a computer anyway.                                                   |

Start with SQLite and see how it goes. If concurrent writes ever become a problem the swap to Postgres is contained,
because all writes go through the event log.

## The event log

Everything turns on NFR-DATA-02: movements are append-only, and status is derived. This is the decision the rest of the
design hangs off, so it is worth being precise.

We do not store `item.status = "out"`. We store the events that happened, and compute status by replaying them.

```
events
  id            ulid, sortable by time, generated on the device
  item_id
  type          checked_out | checked_in | note_added | note_corrected | field_changed | ...
  actor_id
  device_id
  occurred_at   device clock, when it happened
  received_at   server clock, when it arrived
  payload       json
```

Three things fall out of this for free:

**Offline merges stop being scary.** Two phones in the same locker with no signal both append events. Neither overwrites
the other. At sync both sets land, and replay produces one ordered history. There is no last-write-wins field to lose a
check-in to (FR-OFF-05).

**History is real, not a side table.** FR-USR-05's audit log is the same log, filtered. There is no separate auditing
path to forget to call.

**Corrections stay honest.** FR-OUT-16 lets a note be edited; the edit is a `note_corrected` event, not a rewrite. The
original stands. The item page renders the current text.

Derived state (current status, holder, home) is a cache. Rebuild it from the log at any time. Never let a write reach it
except through an event.

### The one hard part

`occurred_at` comes from a device clock, which can be wrong. Order events by `(occurred_at, device_id)` for display, but
never trust device time for anything that must be correct — use `received_at` for retention windows and `id` for
idempotency.

Conflicts a machine cannot settle (two people check the same item out to different events while both offline) queue for
the Quartermaster with both versions (FR-OFF-10). Do not try to resolve these automatically.

## Sync

Two endpoints. No framework.

```
POST /sync/push   { device_id, events: [...] }  -> { accepted: [ids] }
GET  /sync/pull?since=<cursor>                  -> { events: [...], cursor }
```

Push is idempotent on event `id`, so a retry after a dropped connection is safe. Events are batched into one request,
never one call per event (NFR-PERF-05). A day's work is about 100 events and roughly 30 KB, so the 5-second target
(NFR-PERF-04) is spent on round trips, not payload.

Pull is a cursor over `received_at`. Devices take the last 90 days (NFR-DATA-03); the server keeps everything.

Sync runs on app open, on regaining connectivity, and after every movement (FR-OFF-03). It never blocks the screen
(NFR-PERF-06).

**A deactivated account still gets one final push accepted** (FR-OFF-06). The records are gear movements and they are
true regardless of who has since left the group. Accept them, attribute them, then end the session. Rejecting them would
violate NFR-DATA-01.

### Why not a sync framework

The append-only log makes sync small enough to own. A framework would be the largest and least familiar dependency in
the project, which is the opposite of what NFR-MAINT-02 asks for. Roughly a few hundred lines, readable by whoever
inherits this.

## Client

### In memory

500 items is small. Load them all at start, hold them in memory, and filter in JavaScript. NFR-PERF-01's 200 ms search
budget is then met by an array filter with room to spare, and there is no client-side query language to learn or debug.

IndexedDB is the persistence layer underneath: write through on change, read once on boot. NFR-PERF-07 budgets 10 MB for
500 items, which is generous for records with no photos.

### Photos

Photos are server-only and never cached (FR-INV-11). They are fetched on demand when online. This is what keeps the
offline copy small and the sync target honest — one phone photo outweighs a day of events by two orders of magnitude.

### Service worker

Caches the app shell so it starts offline within 3 seconds (NFR-PERF-03). It does **not** do background sync: iOS does
not support it, so the app opening is the reliable trigger (FR-OFF-03). Use Background Sync on Android as a bonus, never
as a design assumption (FR-OFF-08).

Because nothing can sync a closed app on iOS, the unsent count is a persistent banner on every screen (FR-OFF-04).
Visibility is the mitigation.

## Scanning

No browser on iOS implements the BarcodeDetector API, and the experimental flag from iOS 17 does not work on iOS 18. So
the decoder is WebAssembly, running frames pulled off a `getUserMedia` video stream.

**This is the highest-risk piece in the build.** NFR-USE-01 allows 5 seconds from scan to confirmed move, on a cold
phone in gloves, and NFR-USE-02 wants ten of those back to back. If decode latency is poor on an older iPhone, the
product premise is in trouble. Spike this before anything else.

Design around it: keep the camera and the decode loop alive across scans rather than tearing them down per item, so the
cost is paid once per session and not once per tent.

## Codes and labels

Codes are code-first, not item-first (FR-TAG-02). We print sheets of unassigned codes, stick them on gear, and bind each
one by scanning it.

Code identifiers must not be guessable (NFR-SEC-04), so they are random, not sequential. A code has three states:

- **unassigned** — printed, not yet on anything. Scanning offers create-or-bind (FR-TAG-07).
- **assigned** — bound to an item. Scanning opens it (FR-TAG-06).
- **replaced** — was bound, superseded by a new sticker. Still resolves to its item, never reused (FR-TAG-05).

An item has one current code and any number of replaced ones. A sticker that turns up in a field two years later
resolves correctly.

## Server

A single self-hosted instance on a box at a volunteer's house (NFR-DEP-03, NFR-DEP-04). Reachable through an outbound
tunnel rather than a forwarded port, so no home network is exposed (NFR-DEP-05).

Backups are a nightly copy of the SQLite file to somewhere off the machine (NFR-DATA-05, NFR-DATA-06). Restore is tested
before go-live and written down (NFR-DATA-07).

Sessions never expire (FR-USR-07). Sign-in is exchanged once for a long-lived local token; the app never needs to reach
an identity provider from a locker (FR-USR-08).

## Public pages

The only unauthenticated surface: scan a code while signed out, see the item name, the group name, and how to make
contact (NFR-SEC-03). Report it found. Nothing else — no member names, no prices, no history, and no check-in or
check-out (FR-PUB-06).

Rate-limited, because it is the one door anyone can knock on.

## What we are not building

- A sync framework. See above.
- A client-side query engine. 500 items fits in memory.
- Postgres, for now. Revisit if concurrent writes become real.
- Native apps. NFR-DEP-01 rules them out and nothing has argued back.
- Background sync as a design assumption. iOS will not honour it.

## Build order

1. **Spike the iOS scanner.** Everything else is reworkable; this is not.
2. Event log and derived state, server-side, with tests (NFR-MAINT-04).
3. Sync push and pull, including the offline merge case.
4. The scan-to-move flow, end to end on a real phone.
5. Labels, reservations, repairs, reports.
