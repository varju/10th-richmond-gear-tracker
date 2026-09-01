# Architecture

How Gear Tracker is built, and why. Requirements live in [requirements/](requirements/).

The server is small. The client is where the work is.

## Stack

| Layer    | Choice                 | Why                                                                                 |
| -------- | ---------------------- | ----------------------------------------------------------------------------------- |
| Backend  | Python                 | The maintainer's strongest language. Nothing in the requirements argues against it. |
| Database | SQLite                 | One file. Backups and moving house become a file copy (NFR-DATA-06, NFR-MAINT-05).  |
| API      | HTTP + JSON            | Three endpoints carry the sync. No schema layer worth its weight at this size.      |
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

The log is not only about items. Users, locations, codes, reservations, tickets and settings all change offline too, so
they are all events on one log. One replay builds every table the client reads.

```
events
  id            ulid, generated on the device, unique
  entity_type   item | user | location | code | reservation | repair | setting
  entity_id
  type          checked_out | checked_in | note_added | note_corrected | field_changed | ...
  actor_id
  device_id
  device_seq    per-device counter, never reused, gapless
  occurred_at   device clock, raw, when it happened
  clock_offset  the device's estimate of its own clock error at that moment
  effective_at  occurred_at + clock_offset, then clamped; see Ordering
  received_at   server clock, when it arrived
  seq           server counter, assigned on insert; the sync cursor
  payload       json
```

Photos are the exception. They are files, not events, and they never reach a device's offline copy (FR-INV-11).

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

Every timestamp is UTC. Anything a person reads or picks — a reservation's dates, the 30-day overdue window — is
America/Vancouver, converted at the edge (NFR-DATA-12).

### Ordering

Status is derived by replay, so replay order is part of the data model, not a display choice. Two clients and the server
must reach the same answer from the same events.

`occurred_at` comes from a device clock. Getting from that to a time worth storing takes two steps: correct it, then
bound it.

**Correct it.** Every sync measures the gap between the two clocks. The client sends its time, the server replies with
its own, and the client halves the round trip to estimate the difference. It keeps that estimate and stamps it onto each
event it records afterwards, as `clock_offset`. Sign-in needs a network, so every device has a measurement before its
first offline evening.

The offset is stored beside the raw reading, never folded into it. If we later learn an estimate was wrong, the events
recorded under it can be recomputed. Destroying the original observation would be the one edit an append-only log cannot
undo.

**Bound it.** The server then clamps `occurred_at + clock_offset` on arrival and stores the result as `effective_at`:

- never later than `received_at` — a device cannot know the future
- never earlier than the `effective_at` of the previous event from the same `device_seq`

The second rule is what stops a check-in replaying before its own check-out. Causality within a device is preserved by
construction; the raw `occurred_at` is kept, but nothing orders on it.

The two steps catch different things, and the clamp alone is not enough. Its window runs from the device's last event to
the moment of arrival, which for a phone that syncs two days later is two days wide. A clock three hours fast passes
through it untouched. Clamping only catches absurd values; the offset catches the likely ones.

What neither catches is a clock that changes between recording and sync — a flat battery, or someone setting it by hand.
The offset measured on Sunday was not the offset that applied on Friday, and a web app has no monotonic clock surviving
a reload to notice the jump. The partial signal is worth taking: when a fresh measurement differs sharply from the
stored one, the events recorded under the old estimate are suspect, and are flagged rather than trusted.

**Replay order is `(effective_at, device_id, device_seq)`.** Every field is server-assigned or device-monotonic, so the
order is total, stable, and identical everywhere. "Current" — an item's status, its holder, the text of a corrected note
(FR-OUT-16) — means the last event in that order.

Across devices, corrected time is still only a guess at what really happened first, and better clocks do not change
that. Two people scanning the same tent seconds apart cannot be separated by any clock we could build. Where the guess
could be wrong in a way that matters — two check-outs of one item from different devices with no check-in between
(FR-OFF-10) — replay picks an answer and flags the pair for the Quartermaster. It does not silently pick and move on.

So the offset is not what makes ordering correct; `device_seq` and the clamp do that. It is what stops the history
reading wrong. A movement logged at 14:20 that happened at 11:20 is the kind of error a Quartermaster notices, and it
costs more trust than it looks like it should.

## Sync

Three endpoints. No framework.

```
GET  /sync/bootstrap                            -> { snapshot: {...}, cursor, server_time }
POST /sync/push   { device_id, client_time, events: [...] }
                                                -> { accepted: [ids], rejected: [{id, reason}], server_time }
GET  /sync/pull?since=<cursor>                  -> { events: [...], cursor, server_time }
```

Every response carries `server_time`, so each sync re-measures the clock offset described in [Ordering](#ordering).

**Bootstrap** is how a device gets a working copy. Replaying 90 days of log cannot produce one: a tent last touched two
years ago would simply not exist on the new phone. So the server derives current state itself and ships it — items,
users, locations, unassigned codes, open reservations, open tickets, settings — with the cursor it was true at. History
older than the retention window is never on the device; the state it produced is (FR-OFF-14).

The same asymmetry applies to trimming. A device drops history past 90 days, and derives nothing from what it dropped.
It never drops an event it has not yet pushed (NFR-DATA-03).

**Push** is idempotent on event `id`, so a retry after a dropped connection is safe. Events are batched into one
request, never one call per event (NFR-PERF-05). A day's work is about 100 events and roughly 30 KB, so the 5-second
target (NFR-PERF-04) is spent on round trips, not payload. Anything the server refuses comes back in `rejected` with a
reason; the device keeps it and shows it rather than dropping it (NFR-DATA-01).

**Pull** is a cursor over `seq`, a server counter assigned inside the insert transaction. It is not a cursor over
`received_at`: two events can share a timestamp, and an event can commit after a later one has already been read, so a
time cursor skips work silently. `seq` cannot. Pull returns `seq > cursor`, ordered by `seq`.

A cursor the server can no longer honour — older than retention, or from a database that was restored — gets an answer
that says so, and the device bootstraps again.

Sync runs on app open, on regaining connectivity, and after every movement (FR-OFF-03). It never blocks the screen
(NFR-PERF-06).

**A deactivated account still gets one final push accepted** (FR-OFF-06). The records are gear movements and they are
true regardless of who has since left the group. Accept them, attribute them, then refuse everything else that
credential asks for. Rejecting the push instead would violate NFR-DATA-01.

An Admin can also revoke one device without touching the account, for a phone that was lost (FR-USR-14).

### Why not a sync framework

The append-only log makes sync small enough to own. A framework would be the largest and least familiar dependency in
the project, which is the opposite of what NFR-MAINT-02 asks for. Roughly a few hundred lines, readable by whoever
inherits this.

The cost is that replay exists twice: once in Python on the server, once in TypeScript on the client. They must agree or
the client shows something the server does not believe. Keep the ordering rules in one place — a set of JSON test
vectors, each a list of events and the state they must produce — and run them from both test suites (NFR-MAINT-04).

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

Because nothing can sync a closed app on iOS, the unsent count is a persistent banner on every screen (FR-OFF-04), and
work pending more than 3 days interrupts on open (FR-OFF-09). Visibility is the mitigation.

### Keeping the data alive

iOS deletes a website's storage after 7 days without a visit. A phone that scans gear on Friday and is not opened again
would lose the evening's work, which is exactly the failure NFR-DATA-01 forbids. Two defences, both required:

- **Install to the home screen** (NFR-DEP-06). Home-screen apps are exempt from the 7-day rule. This is why that
  requirement is a Must and not a nicety.
- **Ask for persistent storage** via `navigator.storage.persist()` (NFR-DATA-11). If it is refused, say so rather than
  assuming the data is safe.

## Scanning

No browser on iOS implements the BarcodeDetector API, and the experimental flag from iOS 17 does not work on iOS 18. So
the decoder is WebAssembly, running frames pulled off a `getUserMedia` video stream.

Keep the camera and the decode loop alive across scans rather than tearing them down per item, so the cost is paid once
per session and not once per tent.

### What M0 measured

This was the highest-risk piece in the build. It is no longer. Two iPhones, indoor light, codes printed on plain paper,
zxing-wasm decoding a 640px-wide frame in fast mode:

|                                        | Newer phone, Safari     | Older phone, Chrome               |
| -------------------------------------- | ----------------------- | --------------------------------- |
| Time to acquire — median / p90 / worst | not captured            | 0.13 / 0.63 / 1.58 s over 41 aims |
| Ten codes back to back                 | 4.0 s, worst gap 1.33 s | 2.5 s, worst gap 0.63 s           |
| Decoder CPU per frame — median / max   | 3 / 6 ms                | 7 / 37 ms                         |
| Decode attempts per second             | 30.0                    | 23.4                              |
| Frames yielding a code                 | 96%                     | 87%                               |
| Camera dropouts                        | 0                       | 0                                 |

The gate was two seconds for a single scan, and a camera that survives a session. Worst single acquisition was 1.58 s,
and neither device dropped the video track. NFR-USE-02's ten-in-a-row is met with room to spare.

The headroom matters as much as the result. Decoding costs under a fifth of the frame budget even on the slower phone,
so `tryHarder` and a 960px decode are both affordable when conditions get bad. Spend them there, not by default.

**Still untested:** an unlit locker, gloved hands, and scuffed or wet stickers. Those were the reasons for the spike and
they remain open. Anything involving real label stock is waiting on the stock itself; paper does not gloss, scuff or wet
the way a sticker does. What M0 settles is narrower and worth stating exactly: decoding is not the bottleneck, and the
WebAssembly route works on iOS. NFR-USE-01's 5 seconds covers the whole scan-to-confirmed-move loop, most of which is a
person handling a tent, and no bench test reaches that.

## Codes and labels

Codes are code-first, not item-first (FR-TAG-02). We print sheets of unassigned codes, stick them on gear, and bind each
one by scanning it.

### What the QR contains

A full URL, because a stranger's camera app has to do something useful with it (FR-PUB-01). That URL is printed 400
times onto stickers that will outlive several server moves, so the hostname in it cannot be the server's.

So the URL uses a domain the group already owns, pointed at wherever the server currently runs (NFR-DEP-09). The server
can then move house without reprinting the inventory. The path is the random code; the same URL opens the public page
when signed out and the item in the app when signed in.

### Code lifecycle

Code identifiers must not be guessable (NFR-SEC-04), so they are random, not sequential. A code has three states:

- **unassigned** — printed, not yet on anything. Scanning offers create-or-bind (FR-TAG-07).
- **assigned** — bound to an item. Scanning opens it (FR-TAG-06).
- **replaced** — was bound, superseded by a new sticker. Still resolves to its item, never reused (FR-TAG-05).

An item has one current code and any number of replaced ones. A sticker that turns up in a field two years later
resolves correctly.

**Keep the URL short.** Length costs physical module size, which is what survives a scuffed sticker in a dim locker. In
a 0.95in printed box including the quiet zone, at error correction M:

| Encoded                                                         | QR version | Module pitch |
| --------------------------------------------------------------- | ---------- | ------------ |
| `https://www.varju.ca/alex/gear-m0/i.html?c=XXXXXXXXXX` (52 ch) | 4, 33x33   | 0.59 mm      |
| `varju.ca/g/XXXXXXXXXX` (22 ch)                                 | 2, 25x25   | 0.73 mm      |

24% larger modules, for nothing but a shorter path. Decode margin is cheap at design time and impossible to retrofit
once the stickers are on the gear, so the public route is a short path on a short domain (FR-TAG-13).

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

## Testing

Real dependencies, no mocks. SQLite is fast enough that a fake would cost more than it saves: a full migration into a
fresh temporary database takes 1.5 ms, and 10,000 event inserts in one transaction take 12 ms. Database code is tested
against the database.

Three layers, in ascending cost:

**Pure functions, no database.** The clamp and the replay comparator described in [Ordering](#ordering) are pure. They
carry the combinatorial load — hundreds of cases, microseconds each.

**Real SQLite for anything that touches the log.** `seq` assignment inside the insert transaction, idempotent insert on
event id, append-only enforcement, rebuild-from-log. Each test gets its own migrated file under pytest's `tmp_path`. If
setup ever shows up in a profile, copy a pre-migrated template instead; that is 0.8 ms.

Use a file, never `:memory:`. An in-memory database silently ignores `journal_mode = WAL`, so any test about locking,
`busy_timeout` or concurrent readers would pass against settings we do not ship.

**Shared JSON vectors.** Events in, derived state out, run from both the Python and TypeScript suites — see
[Why not a sync framework](#why-not-a-sync-framework). They are data, not code, so they cost almost nothing in either
place, and they are the only thing keeping the two replays honest (NFR-MAINT-04).

### Browser tests

These are the ones that cost seconds rather than milliseconds: a service worker, IndexedDB, and an offline toggle. Keep
them few — one per risk, not one per feature. Scan-to-move, offline merge, and the unsent banner earn one each.

The server side of sync does not need a browser. Test it through real HTTP, in process, against a real SQLite file. That
covers most of what a browser would otherwise be asked to prove.

Browser tests get their own `make` target, separate from `make check`. CI runs both.

### What stays manual

The real-phone-in-a-real-locker test (M7), and everything waiting on label stock. No suite reaches those.

## What we are not building

- A sync framework. See above.
- A client-side query engine. 500 items fits in memory.
- Postgres, for now. Revisit if concurrent writes become real.
- Native apps. NFR-DEP-01 rules them out and nothing has argued back.
- Background sync as a design assumption. iOS will not honour it.
- Automatic conflict resolution. Where time cannot settle it, a person does.

## Build order

1. **Spike the iOS scanner.** Everything else is reworkable; this is not.
2. Event log and derived state, server-side, with tests (NFR-MAINT-04).
3. Sync bootstrap, push and pull, including the offline merge case.
4. The scan-to-move flow, end to end on a real phone.
5. Labels, reservations, repairs, reports.
