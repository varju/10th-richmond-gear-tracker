# Architecture

How Gear Tracker is built, and why. Requirements live in [requirements/](requirements/).

The server is small. The client is where the work is.

## Stack

| Layer    | Choice                 | Why                                                                                 |
| -------- | ---------------------- | ----------------------------------------------------------------------------------- |
| Backend  | Python                 | The maintainer's strongest language. Nothing in the requirements argues against it. |
| Database | SQLite                 | One file. Backups and moving house become a file copy (NFR-DATA-06, NFR-MAINT-05).  |
| API      | FastAPI + Pydantic     | Three endpoints carry the sync. Pydantic models are the only schema.                |
| Client   | TypeScript PWA         | The only way to meet NFR-DEP-01 without an app store. React and Vite, nothing else. |
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
  entity_type   item | user | location | category | code | reservation | repair | found_report | setting
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
except through an event. Append-only is not a convention: triggers on the table refuse `UPDATE` and `DELETE`.

Every timestamp is UTC, stored as integer milliseconds since the Unix epoch. Integers sort and subtract without a
parser, and both replays read them the same way. Anything a person reads or picks — a reservation's dates, the 30-day
overdue window — is America/Vancouver, converted at the edge (NFR-DATA-12).

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
stored one, the events recorded under the old estimate are suspect, and are flagged rather than trusted. "Sharply" is
more than a minute. The flag is a row in the `flags` table, a work queue for a person; the event itself is stored as it
arrived.

**Replay order is `(effective_at, device_id, device_seq)`.** Every field is server-assigned or device-monotonic, so the
order is total, stable, and identical everywhere. "Current" — an item's status, its holder, the text of a corrected note
(FR-OUT-16) — means the last event in that order.

Across devices, corrected time is still only a guess at what really happened first, and better clocks do not change
that. Two people scanning the same tent seconds apart cannot be separated by any clock we could build. Where the guess
could be wrong in a way that matters — two check-outs of one item from different devices with no check-in between
(FR-OFF-10) — replay picks an answer and flags the pair for the Quartermaster. It does not silently pick and move on.
The pair lands in the item's derived state as a `conflicts` entry, so it is part of replay, covered by the shared
vectors, and shipped to every device with the snapshot.

So the offset is not what makes ordering correct; `device_seq` and the clamp do that. It is what stops the history
reading wrong. A movement logged at 14:20 that happened at 11:20 is the kind of error a Quartermaster notices, and it
costs more trust than it looks like it should.

## Sync

Three endpoints. No framework.

```
GET  /sync/bootstrap                            -> { snapshot: {...}, cursor, log_id, server_time }
POST /sync/push   { device_id, client_time, events: [...] }
                                                -> { accepted: [ids], rejected: [{id, reason}], log_id, server_time }
GET  /sync/pull?since=<cursor>&log=<log_id>     -> { events: [...], cursor, log_id, server_time }
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
that says so (HTTP 410, `re-bootstrap`), and the device bootstraps again. A cursor alone cannot tell a replaced database
from the same one, so the log carries a random `log_id`, set when the database is created and kept through a restore.
The device sends the id its snapshot came from, and a cursor from a different log gets the same 410.

Who is calling is settled before any of this runs. The app takes an `authenticate` callable and hands each route a
`Principal`: user, device, and whether the account is still active. M4 supplies the real one.

Sync runs on app open, on regaining connectivity, when the app comes back to the front, and the moment anything is
unsent (FR-OFF-03). It also runs every 30 seconds while the app is on screen, so a check-out on one phone reaches
another within half a minute. A record reaches the server within a second of being made; records pile up on the device
only when a sync fails, and then a watcher retries with a growing delay until one succeeds or the network returns. Sync
never blocks the screen (NFR-PERF-06).

Polling every 30 seconds, rather than holding a socket open, is a deliberate choice. A WebSocket or server-sent events
would need a connection held open through the group's proxy and tunnel, a reconnect path on every phone, and a second
delivery path to keep honest beside pull. Half a minute is fast enough for two phones in one locker, and it costs one
request the server already answers.

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
vectors under `vectors/replay/`, each a list of events and the state they must produce — and run them from both test
suites (NFR-MAINT-04).

## History

A device holds 90 days of events, which is right for a locker and wrong for "when did we buy this tent". So the history
screens ask the server first, and fall back to what the device holds (FR-INV-31).

```
GET  /history/<entity_type>/<entity_id>         -> { events: [...], server_time }
GET  /history/<entity_type>                     -> { events: [...], server_time }
```

Signed-in callers only. Events come back in replay order, shaped exactly as pull sends them, so the same code draws
both. The screen adds anything this device has recorded and not yet pushed, matched by event id, because a note written
a minute ago must not vanish when the signal returns. Nothing is cached: this is a read, and a stale answer would be
worse than a slow one.

A merged duplicate is its own entity, so an item page asks once per id it follows (FR-INV-13). The repair report asks
for the whole `repair` type at once, because it is a list of tickets rather than one. On failure or with the device
offline the screen says "Offline: what this device knows, the last 90 days."; on success it says nothing, because there
is nothing missing.

## Client

### In memory

500 items is small. Load them all at start, hold them in memory, and filter in JavaScript. NFR-PERF-01's 200 ms search
budget is then met by an array filter with room to spare, and there is no client-side query language to learn or debug.

IndexedDB is the persistence layer underneath: write through on change, read once on boot. NFR-PERF-07 budgets 10 MB for
500 items, which is generous for records with no photos.

### On the device

Two stores: `meta` (device id, session, cursor, clock offset, snapshot) and `events`. State is the snapshot with every
known event replayed on top, recomputed on each change; at this size that is cheaper than keeping it incrementally
correct. Every event this device records is stamped with the current clock offset (NFR-DATA-13) and marked unsent until
the server confirms it. An event the server rejects is kept for the record and no longer replayed.

Each sync pushes first, then pulls until a page comes back empty. On a 410 it bootstraps again; unsent work survives a
bootstrap and is replayed on top of the new snapshot. After a sync, events older than 90 days that the server has
already sequenced are folded into the snapshot (NFR-DATA-03). Nothing unsent is ever folded.

Leaving a screen that holds a draft asks first: save, discard, or keep editing (FR-INV-20). Each form registers its
draft through one hook, and every exit goes through one guard that either runs at once or waits for the answer. The
browser's own question covers closing or reloading the tab.

Back follows the way in, not a fixed path: every entry the app pushes records how deep it is (`lib/router.ts`), so the
back arrow calls the browser's own back, and falls back to a named path only when the screen was opened cold, such as
from a sticker's URL. The lists hold their search, filters and sort in the query string and replace the entry as they
change, so a step back restores the view someone left and typing does not fill the back button with keystrokes.

The phone's home screen holds only what someone at a locker came to do: check out, return, search, and add an item, with
alerts above them and every other screen in a "More" fold. The two buttons open the scanner in a mode, and a scan that
disagrees with the mode warns instead of flipping (FR-OUT-06). The full list lives at `/items` instead, because 500 rows
pushed Scan off the screen and the list is the least of what a locker visit needs (NFR-USE-01, NFR-USE-03).

The Python server serves the built client, so one process is the whole deployment. In development Vite serves the client
and forwards API calls.

### Wide layout

One breakpoint at 900 px (`lib/wide.ts`, repeated in `styles.css`). Above it the same app is arranged for a table
(NFR-USE-10): the sections leave the phone's More fold for a sidebar that stays beside every screen, the home screen
opens on exceptions and then what is out, and the inventory becomes a sortable table with search and filters always in
view. Below it nothing changes; the phone layout is not adjusted to suit the desk.

Most of the difference is CSS. `useWide()` is for the few screens whose element order must differ, because a grid cannot
reorder what the DOM does not allow: the reservation form and the reservation page. The item page splits into two
columns with wrapper elements alone, since its order already suits both. The desk home and the inventory table are
separate components, chosen by the router, because they answer different questions from the same state.

Tap targets keep their 44 px at every width. The same components are opened on a phone, and a mouse is happy with a big
target (NFR-USE-03).

### Photos

Photos are server-only and never cached (FR-INV-11). They are fetched on demand when online. This is what keeps the
offline copy small and the sync target honest — one phone photo outweighs a day of events by two orders of magnitude.

They are plain files in `photos/` beside `gear.db`, on the same volume, named by a ULID the device made. No object
store, no second service. Whatever snapshots and copies the database already covers them, and moving house stays a copy
of one directory (NFR-MAINT-05). `gear-serve --photos` moves the directory for anyone who needs it elsewhere.

The bytes and the record are kept apart. A device shrinks the picture (1600 px, JPEG) and, with no signal, holds it in
its own IndexedDB store, outside the event log and outside the snapshot. At the next sync, after push and before pull,
it `PUT`s the bytes under that id. The server writes the file, then appends `photo_added` itself, with the uploader as
actor; a device may not push that event, because a record of a file the server does not have is a broken link. The event
comes back through pull like any other, so every phone knows the photo exists and can fetch it when online. The id being
the device's makes a retry after a dropped connection idempotent: the server sees the id already on the entity and
writes nothing. Removing a photo is `photo_removed` from the device. The file stays on disk. The log is append-only, the
event says the photo is no longer shown, and a volunteer who wants the disk back can compare the directory with the log.

`<img src>` cannot carry the bearer token, so the app fetches the bytes and shows them from memory. The service worker
never answers a `/photos` request, and the server sends `Cache-Control: no-store`.

### Service worker

Caches the app shell so it starts offline within 3 seconds (NFR-PERF-03). It does **not** do background sync: iOS does
not support it, so the app opening is the reliable trigger (FR-OFF-03). Use Background Sync on Android as a bonus, never
as a design assumption (FR-OFF-08).

Because nothing can sync a closed app on iOS, the unsent count is a persistent banner on every screen (FR-OFF-04), and
work pending more than 3 days interrupts on open (FR-OFF-09). Visibility is the mitigation. The banner gives a fresh
record a few seconds to land before calling it unsent, so a save does not flash yellow on every tap.

### Keeping the data alive

iOS deletes a website's storage after 7 days without a visit. A phone that scans gear on Friday and is not opened again
would lose the evening's work, which is exactly the failure NFR-DATA-01 forbids. Two defences, both required:

- **Install to the home screen** (NFR-DEP-06). Home-screen apps are exempt from the 7-day rule. This is why that
  requirement is a Must and not a nicety. Install before recording anything: on iOS the installed app has its own
  cookies, local storage and IndexedDB, so it opens signed out and empty and cannot rescue what is already sitting in
  the Safari tab. The prompt says so. The icon is named for the group: the server rewrites `name` and `short_name` in
  the built manifest from the group setting, because a build cannot know whose gear it is.
- **Ask for persistent storage** via `navigator.storage.persist()` (NFR-DATA-11). Chromium grants it to an installed
  app. iOS refuses every site, so a refusal is not shown: the unsent count is already on every screen, and the answer to
  both is the same, open the app with signal.

Neither promise covers a full disk. A browser may still clear the site to free space, and Apple publishes no rule for
when. Sync on every change, on open, and on regaining signal keeps that window to minutes with signal and hours without.
A lost record is a missing movement, not a broken database; the next scan of the item puts it right.

### Store wrapper

A Could (NFR-DEP-11), not planned. Written down so the argument is settled once.

**What it buys.** The home-screen install is the one step a volunteer can skip, and skipping it puts their Friday's work
under the 7-day rule. An app from the App Store has its own storage that Apple does not purge, so the install step and
the prompt around it go away. Nothing else improves: the scanner already meets its gate in WebAssembly, and background
sync is still not on offer.

**What it is.** Capacitor around the built client, the bundle shipped inside the app and served from a local scheme, so
the shell is on disk and offline needs no service worker. The same code talks to the same server. No feature lives only
in the wrapper; a volunteer on the web must never be second class, or NFR-DEP-01 is dead in all but name.

**How it ships.** Unlisted App Store distribution: a normal App Review with a note asking for unlisted, plus a separate
request form. Both are needed. The app is hidden from search and charts and installs from a link. The switch to unlisted
is permanent for that app record. Every client release then passes review, a day or two of latency, and a phone can lag
a release behind, so the server keeps sync compatible with the previous store build.

**What can kill it.** Guideline 4.2, minimum functionality: Apple rejects apps that repackage a website. A bundled
offline client with camera access is more than that, but the call is Apple's, and the first submission is the test.
Android is untouched: the web client stays the only route there.

**Gate.** Build it only if first feedback (M10) shows volunteers failing to install, or losing work to the 7-day rule.
Neither has happened.

## Inventory

Items and locations are entities on the same log as everything else: `created` once, then one `field_changed` per edit,
with the old value kept. Retiring an item is a field, `retired`, so the item and its history stay (FR-INV-04). Deleting
one is another field, `deleted`, written by an Admin for a record made in error (FR-INV-32): it hides the item
everywhere, including from "show retired", and the app offers no way back. The log and the photo files stay, and so does
the sticker, because a code binds once; scanning it opens a page that says the item was deleted.

**Generic items and units are both items.** A generic has `generic: true` and no code; a unit has `parent_id` and a
`number` unique under that parent, and no name unless a nickname is set. Display name is derived: the parent's name, the
number, the nickname if any. One entity kind means one form, one page, one search, and photos and description work the
same on both. The guards are two checks: a generic takes no code and no movement. There is no type entity; a type was a
name with nothing behind it, and a generic is where that name lives now (FR-INV-21).

Making a single item generic creates a new generic and sets `parent_id` on the old item (FR-INV-26). Nothing about the
old item's history is rewritten. Numbers are picked on the device and can collide when two phones label the same generic
offline; the second to land keeps its number and the unit page says so, the same trade as every other offline race.

Three things the app names differently from the data. The item field the requirements call notes is `description`,
because `notes` in derived state is the list of per-movement notes (FR-OUT-13). The label the app calls a shelf is
`sub_location`, named before the yard's trailers made "shelf" the word people used anyway (FR-SET-03). And `added_at`
and `modified_at` are written by replay from the event's effective time, not sent by the device, so a phone with a wrong
clock cannot set them (FR-INV-03). Only `created` and `field_changed` move `modified_at`; movements and notes do not.

Locations are deleted by setting `deleted`; the row stays so items still pointing at it keep a name. The in-use check
(FR-SET-05) runs on the device against its own state, which is the only state it has. Two phones offline at once can
race it: one deletes a location while the other files an item there. The item wins, the location is hidden, and the
item's home still reads correctly. That is rare enough to accept and cheap to fix by hand.

**Categories** are entities like locations (FR-SET-07): the same create, rename and delete, and the same in-use check
(FR-SET-05). Each item carries `category_ids`, a list, on a single item or on a generic; a unit carries none and reads
its generic's, so re-filing a generic re-files its units. An item from before September 2026 may still carry the old,
single `category_id`, and readers treat it as a list of one. The phone list groups by category, uncategorised last; the
desk table gets a sortable column instead, because a table already sorts.

**CSV export and import** (FR-RPT-03, FR-SET-11) are one module, `inventory_csv.py`, reached from Settings and from
`gear-admin export` and `gear-admin import`. The export is derived state, one row per live item, home and category by
name so a spreadsheet reads it; code, status and holder are there to read and are ignored on import. The import is the
same columns back: a row with an id is an edit, a row without one an add, each written as ordinary events by the server
as the Admin. The whole file is checked before anything is written, so one bad row stops it and the errors name their
rows.

Shelves are labels on items, not entities (FR-SET-03). The suggestion list is whatever labels are in use.

### Codes on the device

A code is an entity whose id is the code itself. The server creates them when it prints a sheet; devices may only bind
them, with one `code_bound` event carrying the item id. Replay records `item_id` and `bound_at` on the code and nothing
on the item, so an item's current code is a question answered by reading its codes: the one bound last is current, the
rest are replaced and still resolve (FR-TAG-05). The server refuses a second binding of the same code at push time; the
two-phones-offline race leaves the loser's item without a code and a rejection explaining why.

A device may also release a bound code, deliberately, with a `code_released` event that clears `item_id` (FR-TAG-14).
Unlike a replace, this is not superseded by a new sticker: the code goes back to unassigned and may be bound to a
different item later. The server refuses to release a code that is not on anything.

Scanning lands on `/g/<code>`, the same path a sticker's URL has, so a camera app and the in-app scanner take one route.
Assigned or replaced: open the item. Unassigned: create or bind. Unknown: say so, and suggest a sync, because a freshly
printed sheet is unknown to a phone that has not pulled since.

## Merging duplicates

The same tent entered twice is fixed with one `field_changed` on the duplicate: `merged_into`, naming the survivor
(FR-INV-13). Nothing is rewritten. An append-only per-item log cannot move history from one id to another without
forging events, so the pointer stays and readers follow it.

What follows the pointer: a sticker on the duplicate opens the survivor; the survivor's history and repair tickets
include the duplicate's; a reservation that named the duplicate packs the survivor; the list hides the duplicate; and
the server refuses to check the duplicate out. What does not: notes stay on the duplicate's page, which is still
reachable and says where it went. Only an Admin merges, and only an item that is in. Unmerging is another
`field_changed`, setting `merged_into` back to null, offered on both pages: the survivor lists what was merged into it,
one line each, with the way back beside it.

**Merging is not grouping.** A merge says two records are one thing, and one of them has to go. Grouping says two things
are the same kind, and both stay (FR-INV-30). So grouping writes no `merged_into`: it makes a generic and sets
`parent_id` and a number on each item, the same three fields FR-INV-26 writes, and nothing is hidden or followed
afterwards. Picking a generic, or one of its units, joins the generic already there rather than making another. The tell
is whether the gear exists twice in the locker. Two tents means a group; one tent entered twice means a merge. Grouping
is an ordinary edit, so anyone signed in may do it; merging stays with an Admin, because it takes a record off the list.

## Movement

A check-out is `checked_out` with the holder, the session's event name, and nothing else; a check-in is `checked_in`.
The holder is whoever is signed in. Gear handed to someone without an account is covered by a note (FR-OUT-15), not a
holder field that would need its own list of people.

The session event (FR-OUT-05) is a device setting in `meta`, stamped onto each check-out as it is recorded. It is not a
record, so two phones at one camp each type the name once and nothing is shared or reconciled.

Taking gear that is already out is a `checked_out` whose payload names the check-out it `supersedes` (FR-OUT-12). That
is how replay tells a transfer from a conflict: the conflict rule (FR-OFF-10) fires on two check-outs from different
devices with no check-in between, unless the later one says it saw the earlier. Someone who scanned an out item and
tapped "Transfer" saw it; two phones offline in two lockers did not.

Replay records a conflict on the item and never clears it; the log is not the place for a verdict. A conflict is open
while its later check-out is still the item's current movement and nobody has reviewed it. A check-in or a transfer
closes it by moving on. Reviewing it, on the Conflicts screen, records one `field_changed` on the item,
`reviewed_movement`, naming that check-out: the holder stands, the movements are untouched, and the screen shows both
versions in words until one of those happens (FR-OFF-10).

Notes ride on the item, not the movement, as `note_added` events. One that belongs to a movement carries its
`movement_id`, so it can be shown under the right check-out and still be corrected later by `note_corrected`
(FR-OUT-16). Movement events themselves carry no note text.

The one thing on a movement that can be put right is the event it was recorded under, by an appended `event_corrected`
naming it (FR-RES-17). Replay carries the item's last movement only, so a correction to that one lands in state and
decides what the item is out under; a correction to an older one is read back from the log, where the history is. The
check-out itself is never rewritten, the same rule as a note (FR-OUT-16).

The access history on an item page (FR-INV-09) is read from a log: the server's, when there is signal, and otherwise the
90 days of events the device holds (NFR-DATA-03). One render path draws either, so the rows do not change shape when the
signal does; only the note under them does. See [History](#history).

## Repairs

A ticket is a `repair` entity: `created` with the item it is against and a description (FR-REP-01), by anyone signed in
(FR-REP-02). Its state is a field, moved by `field_changed` through open, in progress, resolved and won't fix
(FR-REP-03); replay opens it open, so a device sends no state. Comments are the same `note_added` and `note_corrected`
as an item's notes (FR-REP-06). Cost, time and parts go in a comment; there are no fields for them.

Open means open or in progress. An item with an open ticket is flagged in the list, on its page and on the scan card,
and the flag warns without blocking (FR-REP-05, FR-RES-08). Closed tickets stay on the item (FR-REP-04): the list on the
item page is read from state, not from the 90 days of history the phone holds.

A problem typed on the scan card is recorded after the movement, as a second event, so a check-in and the ticket it
raises are one flow (FR-OUT-09). A ticket takes photos the same way an item does (FR-REP-01); see [Photos](#photos).

The repair report (FR-RPT-02) is the open list followed by a history over a date range, both derived on the phone from
the tickets it holds. Days are calendar days where the group is. With signal the list is built from every `repair` event
the server holds, so the range reaches back as far as the log; without it, as far as the phone's copy does, and the
phone says so under the list.

## Reports

The first report, what is out and who has it, is derived on the phone from local state. It needs no network and no
server query. Items are grouped by holder. The overdue period is one group setting; there are no per-item due dates.
Days out is the whole days since the check-out, rounded down.

Missing is a field on the item, not a status (FR-INV-19). An item can be out and missing: the check-out is still true,
and nobody knows where the gear went. It drops off what-is-out, and the next scan or check-in clears it, because either
one means the item is in someone's hand. Retire is for gear written off; missing is for gear that is only lost.

A stock check (FR-RPT-09) records no event. The phone knows which shelf it is at only because a person picked it, and
"in but not at home" is true for the length of the walk and no longer: the next check-in puts the item wherever the
person puts it. So the walk is a device setting — where, and what has been scanned there — and the two lists, misplaced
here and not seen yet, are computed against state as the person goes. Each scan does clear missing, and that is an
event. Browsing by location (FR-INV-10) is the same question at rest: what state says belongs on each shelf.

## Reservations

A reservation is one entity: `created` with the event name, its days, the units it names and the generics it wants so
many of (FR-RES-01, FR-RES-13). Event and dates are `field_changed`, one per field. Cancelling is a field, so the record
stays.

The gear list is edited one line at a time: `item_added`, `item_removed`, `quantity_changed` on a generic line. Never
the whole list. Two phones packing one camp offline each scan an extra (FR-RES-07); a whole-list write would keep one
and drop the other, and per-line events keep both. Linking gear already out (FR-RES-17) is one of these plus an
`event_corrected` on the movement, the same shape as a note correction (FR-OUT-16).

The days are calendar dates, `YYYY-MM-DD`, not timestamps. A camp starts on a day, not at an instant, and text order is
date order. "Today" is the day in America/Vancouver, computed on the device (NFR-DATA-12). Overlap is inclusive: two
camps that share a day share the gear.

**Packing records nothing of its own.** An item is ticked off when it is out under the reservation's event, which the
item's last movement already says. So the remaining list is derived from state, a reload loses nothing, and two phones
packing one camp agree as soon as they have synced. For a generic, any unretired unit of it checked out under the event
counts, except one the reservation names, which is its own line. Finishing the session records nothing either: the
reservation is a plan, and the movements are the record.

Conflicts are checked on the device, against the state it has (FR-RES-05, FR-RES-15). Two phones offline can both save
clashing reservations; both land, and the reservation page then names the clash. That is the same trade as the in-use
check on locations, and as rare.

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
when signed out and the item in the app when signed in. The address is the group's site address, a setting in the app;
the app appends `/g/<code>` to it to make the URL.

### Code lifecycle

Code identifiers must not be guessable (NFR-SEC-04), so they are random, not sequential. A code has three states:

- **unassigned** — printed, not yet on anything. Scanning offers create-or-bind (FR-TAG-07).
- **assigned** — bound to an item. Scanning opens it (FR-TAG-06).
- **replaced** — was bound, superseded by a new sticker. Still resolves to its item, never reused (FR-TAG-05).

An item has one current code and any number of replaced ones. A sticker that turns up in a field two years later
resolves correctly.

A fourth move, releasing, takes an assigned or replaced code deliberately back to unassigned (FR-TAG-14): the sticker is
off the gear, and the printed code is free to go on something else. Unlike a replace, nothing else takes its place on
the item.

**Keep the URL short.** Length costs physical module size, which is what survives a scuffed sticker in a dim locker. In
a 0.95in printed box including the quiet zone, at error correction M:

| Encoded                                                         | QR version | Module pitch |
| --------------------------------------------------------------- | ---------- | ------------ |
| `https://www.varju.ca/alex/gear-m0/i.html?c=XXXXXXXXXX` (52 ch) | 4, 33x33   | 0.59 mm      |
| `varju.ca/g/XXXXXXXXXX` (22 ch)                                 | 2, 25x25   | 0.73 mm      |

24% larger modules, for nothing but a shorter path. Decode margin is cheap at design time and impossible to retrofit
once the stickers are on the gear, so the public route is a short path on a short domain (FR-TAG-13).

Size changes in steps, though, not smoothly. What matters is which side of a step a URL falls on:

| Encoded length | QR version | Module pitch |
| -------------- | ---------- | ------------ |
| up to 26 ch    | 2, 25x25   | 0.73 mm      |
| 27 to 42 ch    | 3, 29x29   | 0.65 mm      |
| 43 ch and up   | 4, 33x33   | 0.59 mm      |

That settles a question worth not reopening. `10thrichmond.ca` is 15 characters, so 25x25 was never within reach: even
`10thrichmond.ca/g/XXXXXXXXXX` is 28. The app is served under `/gear`, and `10thrichmond.ca/gear/g/XXXXXXXXXX` is 33 —
the same 29x29 as the shorter path, with nine characters spare. Giving the codes their own route at the domain root
would buy no decode margin at all.

The step at 43 is the one to stay under, and `https://www.10thrichmond.ca/gear/g/XXXXXXXXXX` is 45. Dropping the `www.`
is enough to clear it; dropping the scheme as well leaves real headroom, and is what the shorter example above does. Set
the group's site address accordingly before any sheet is printed.

**Capitals would buy a step, and we are not taking it.** All of the above is byte mode, at 8 bits a character. QR also
has an alphanumeric mode at 5.5, whose charset is digits, uppercase A-Z and a few symbols — a whole URL, so long as
nothing in it is lowercase. Crockford is uppercase already, so the codes encode that way today; the host and path do
not.

| Encoded                             | QR version | Module pitch |
| ----------------------------------- | ---------- | ------------ |
| `10thrichmond.ca/gear/g/XXXXXXXXXX` | 3, 29x29   | 0.65 mm      |
| `10THRICHMOND.CA/GEAR/G/XXXXXXXXXX` | 2, 25x25   | 0.73 mm      |

The same 33 characters, the same code, the same 50 bits, and 12% larger modules. In that mode 38 characters fit at
25x25, so there are five to spare. A denser alphabet goes the other way: base62 saves a character and loses the mode,
because mixed case forces byte mode back on, and stays at 29x29 with no gain.

The costs are a redirect from the capitalised path to the canonical lowercase one, kept for as long as the stickers
exist, and a sticker that reads in capitals. Settled in September 2026: the stickers stay lowercase at 29x29. A redirect
that has to outlive 400 labels is a standing obligation on whoever inherits this, and 0.65 mm modules already cleared
M0's bar. Recorded so the question is not reopened by the next person who reads a QR specification.

## Found gear

A stranger who scans a sticker gets the public page and one form: where is it, and, if they like, how to reach them
(FR-PUB-02). The server takes that at `POST /public/codes/<code>/found` and writes a `found_report` event itself, under
the actor `public`. It is on the same log as everything else, so it reaches every phone with the next pull and is read
offline like the rest (FR-PUB-03). The report is the finder's words: a device may not create one, and the only change it
may make is to set `resolved` when someone has dealt with it. The report stays in the log after that, like everything
else.

What is stored is the code, the item it was on at the time, the note, and the contact. The route reads nothing else
about the item and returns nothing but the server time (NFR-SEC-03).

Three rate limits stand in front of it (FR-PUB-04): five an hour per address, three a day per sticker, and thirty an
hour in all. They live in memory in the one server process, which is all there is. The address is the first hop of
`X-Forwarded-For`, because the app sits behind the group's proxy. The form also carries a field no person sees; a
submission that fills it is thanked and thrown away. None of this stops a determined person, and it does not have to. It
stops scripts, and it caps what one bored teenager can put on the log in an evening.

## Server

A single self-hosted instance on a box at a volunteer's house (NFR-DEP-03, NFR-DEP-04). Reachable through an outbound
tunnel rather than a forwarded port, so no home network is exposed (NFR-DEP-05).

Backups are a nightly `gear-backup`: SQLite's online backup API rather than a file copy, because in WAL mode the file on
disk is not the database until a checkpoint lands. Each snapshot is integrity-checked as it is written, which is the one
thing a copy cannot do — it says nightly whether the database is still sound. Thirty are kept (NFR-DATA-05). They leave
the machine on the host filesystem's own schedule rather than through a second tool (NFR-DATA-06). Restoring is in
[deploy.md](deploy.md#restoring) (NFR-DATA-07).

### Seeding

`GEAR_DATA/seed.toml`, read by `gear-admin seed` at every start (NFR-DEP-10). TOML because the standard library parses
it and a volunteer can read it. The file holds the first Admin, the group setting, and the mail account, and nothing
else: locations, items, and users beyond the first are made in the app.

Seeding is idempotent. The Admin is created only if no account has that email; the group setting and mail are written
only where the file differs from what is stored, as ordinary events by the server on the Admin's behalf. So a start with
an unchanged file writes nothing, and a start on an empty database writes everything. The Admin's password is in the
file; it is used once, at creation, and a later change in the app is not undone by the file.

The file is a secret: it holds the Admin and mail passwords. It sits in `GEAR_DATA` beside the database, which is
already off the repository, and `seed.toml` is ignored by git in case one is made locally. `seed.example.toml` is
committed with placeholders.

**Inventory is a different file with a different rule.** `src/gear_tracker/fixtures/demo.toml` is committed and ships in
the package: locations, generic items with units, single items, no codes. `seed.toml` opts in with `inventory = "demo"`,
or a path to a file of the group's own. It loads only into a database with no items, and never again: after that the app
is the truth, and a changed file waits for the next wipe. Config is secret and the file always wins; test data is public
and the database always wins. The browser tests load the same file instead of building data by hand (NFR-MAINT-10).

### Accounts

A user is two things, kept apart.

The person — name, role, active — is an entity on the event log like everything else. Inviting, deactivating,
reactivating and changing a role are `created` and `field_changed` events with the Admin as actor, so the audit trail
(FR-USR-05) is the log and nobody is ever removed from it (FR-USR-06). Every `field_changed` carries the old value
beside the new one.

The credential — email, argon2 password hash, sessions, one-time links — lives in server-only tables and never reaches a
device. Twenty phones hold the inventory; they do not need to hold twenty email addresses.

Sessions never expire (FR-USR-07). Sign-in is exchanged once for a long-lived token per device; the app never needs to
reach an identity provider from a locker (FR-USR-08). The token is stored hashed. A deactivated account's sessions are
kept, marked inactive, so the final push can land (FR-OFF-06). That push ends the session; nothing else is accepted.

Invite and reset links are one-time tokens (FR-USR-12). They die after seven days unused; sessions do not expire, links
do. Redeeming a reset revokes the sessions the old password opened.

The link is always shown for the Admin to pass on. A group that fills in an SMTP account gets it mailed as well
(FR-USR-15): one mailbox at whatever provider the group already uses, an app password rather than the real one, in a
server-only table beside the credentials (NFR-SEC-10). Mailing is never fatal — a refused message leaves the invite made
and the link on the screen. The app sends the server a link with `TOKEN` where the token goes, so the server never has
to know its own public address (NFR-DEP-09).

A lost or sold phone is revoked on its own (FR-USR-14). An Admin sees the devices a person is signed in on and ends the
sessions of one; the account, its other phones and its events are untouched. Anyone sees their own devices in Settings
and revokes one there the same way (FR-USR-17); an Admin does it for anyone under Users. The phone keeps its copy of the
inventory until it next tries to sync, is refused, and signs itself out. What sits on it until then is behind the
phone's own lock (NFR-SEC-06). Invite and reset links open `/join` in the app, which sets the password and signs that
phone in.

The first Admin is made at the keyboard with `gear-admin create-admin` (FR-USR-13). `gear-admin reset-link` is the way
back in when every Admin has lost their password; the keyboard is the credential.

User changes come only through the accounts API, never as events pushed from a device. That is where the last-Admin rule
(FR-USR-03) and the role check live, and it is why they hold. Events the server originates carry `device_id = "server"`
and their own `device_seq`, under the same rules as any phone.

## Assistant access (MCP)

The MCP server is the same FastAPI process, answering at `/mcp` over Streamable HTTP, using the official Python SDK,
pinned. One process to run; nothing new to deploy. It is stateless and replies in plain JSON, so there is no session to
keep and no stream for a proxy to buffer. Calls are rate limited per token, generously, by the same `RateLimit` the rest
of the app uses.

**A token is a device.** "Connect an assistant" in Settings opens a session whose `device_id` is `mcp-<ulid>`, and shows
the token once. Everything that already works for a phone works for it: it is in the device list, it is revoked the same
way, and a deactivated user's token dies with the account. Middleware resolves the bearer token before the SDK sees the
request, so a bad one is a 401. A phone's token is refused too, with a 403: its `device_seq` belongs to the phone, and
the server must not hand out numbers alongside it. No OAuth until a client forces it (FR-MCP-07).

**A write is a push.** A tool call builds events server-side with the session's `device_id` and a `device_seq` the
server keeps per MCP device in a `device_seq:<device_id>` meta row, seeded from the log and bumped in one statement,
then hands them to `sync.push`. So the entity rules, validation, attribution, and drift checks all apply, and history
reads "this Scouter, via the assistant". There is no second write path.

**A read is derived state.** Tools read what `bootstrap` already serves, plus recent movements for one item. The readers
live in `views.py`, a Python twin of the client's `inventory`, `reservations`, `reports` and `repairs` modules.

**Conflicts move to Python too.** Reservation clashes are checked on the device today. An assistant needs the answer in
the reply, so `conflicts` gets a Python twin with shared vectors under `vectors/reservations/`, the same arrangement as
replay. A reservation tool that hits a clash refuses to save and names it, exactly as the app does.

**What is not there.** Nothing an Admin does. The app gates locations to Admins, so MCP does too, though the server
would let a device write them.

## Public pages

The only unauthenticated surface: scan a code while signed out, see the item name, the group name, and how to make
contact (NFR-SEC-03). Report it found. Nothing else — no member names, no prices, no history, and no check-in or
check-out (FR-PUB-06).

One route answers it, `/public/codes/<code>`, and it names the three fields it returns rather than filtering an item
down. Nothing else is read, so a field added to an item later cannot arrive on the public page by accident.

The contact route is a group setting. A sheet of codes will not print until it is set: a sticker becomes a public page
the moment it goes on gear, and one with no way back to us is no use to whoever finds the tent.

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

These are the ones that cost seconds rather than milliseconds: a service worker, a real browser, and an offline toggle.
Keep them few — one per risk, not one per feature. Cold start offline, scan-to-move, and offline merge earn one each.
IndexedDB does not need a browser: the client suite runs the store against an in-memory implementation of the same API.

The server side of sync does not need a browser. Test it through real HTTP, in process, against a real SQLite file. That
covers most of what a browser would otherwise be asked to prove.

Browser tests get their own `make` target, separate from `make check`. CI runs both.

One of them is an accessibility audit: axe runs WCAG 2.2 AA checks on the main screens against the real build
(NFR-A11Y-01). It runs in the browser because contrast needs real layout. What axe cannot judge, focus order and whether
a screen reader makes sense of the check-out flow, stays manual (NFR-A11Y-04).

### What stays manual

The real-phone-in-a-real-locker test (M7), and everything waiting on label stock. No suite reaches those.

## What we are not building

- A sync framework. See above.
- A client-side query engine. 500 items fits in memory.
- Postgres, for now. Revisit if concurrent writes become real.
- A native rewrite. NFR-DEP-01 rules it out. A store wrapper around the same client is a Could; see
  [Store wrapper](#store-wrapper).
- Background sync as a design assumption. iOS will not honour it.
- Automatic conflict resolution. Where time cannot settle it, a person does.

## Build order

1. **Spike the iOS scanner.** Everything else is reworkable; this is not.
2. Event log and derived state, server-side, with tests (NFR-MAINT-04).
3. Sync bootstrap, push and pull, including the offline merge case.
4. The scan-to-move flow, end to end on a real phone.
5. Labels, reservations, repairs, reports.
