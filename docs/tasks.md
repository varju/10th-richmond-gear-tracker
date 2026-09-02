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

- [ ] Category joins the filters when categories exist (FR-INV-08, FR-SET-07)
- [ ] Check the printed sheet against real Avery 6576 stock and fix `labels.py` if the margins are off (FR-TAG-02)

## M7 — Movement

The vertical slice is built. What is left needs a phone.

- [ ] End-to-end test on a real phone with wifi and data turned off

## M19 — Seed a fresh instance

Before M8, which resets the deployed database. Design in [architecture.md](architecture.md#seeding).

- [ ] `gear-admin seed --file`: first Admin with password, group setting (name, code URL, contact, overdue days), mail.
      Idempotent; the password is used only at creation. Tests against a real file: empty database, unchanged file,
      changed field, password changed in the app and left alone.
- [ ] `seed.example.toml` committed with placeholders; `seed.toml` in `.gitignore`.
- [ ] `fixtures/demo.toml`: the three locations, a few generics with units, a few single items. Loaded by
      `gear-admin load --file` into an empty database only; refuses otherwise (NFR-MAINT-10). Waits on M8 for generics.
- [ ] `inventory = "demo"` or a path in `seed.toml` runs the loader after config. The e2e suite loads the same file.
- [ ] The entrypoint runs seed after migrate when `/data/seed.toml` exists.
- [ ] `make start-over`: stops the container, moves `gear.db` and `photos/` aside under a timestamp, starts again.
      Nothing is deleted; the old copy is removed by hand later.
- [ ] deploy.md: a "Start over" section, and "The first Admin" rewritten around the seed file with the command line as
      the fallback.

## M8 — Generic items and units

Before the labelling walk (M9): this is what makes the walk one tap per tent, and the deployed database is reset rather
than migrated. Design in [architecture.md](architecture.md#inventory).

- [ ] Replay: `generic`, `parent_id`, `number`, `nickname` on items; the `item_type` entity removed. Both replays and
      the vectors, including two phones numbering the same generic offline.
- [ ] Item form: "we have several of these". On a new item, saves a generic. On an existing item, creates the generic
      and moves the item under it as #1 (FR-INV-26).
- [ ] Unit form: suggested next number, editable, unique under the parent; optional nickname; home defaulting from the
      generic (FR-INV-23, FR-INV-29).
- [ ] Code landing: "another of" recent generics beside New item, one tap to a unit (FR-INV-24).
- [ ] Inventory list: one row per generic with counts, opening to units; search on the generic's name; filters on units
      (FR-INV-25). Type filter removed.
- [ ] Item page for a generic: shared fields, units with status; retire only when every unit is (FR-INV-27). Unit page:
      parent link, number, nickname, move to another generic (FR-INV-28).
- [ ] Reservations: quantity lines point at generics; clash check counts unretired units (FR-RES-13, FR-RES-15).
- [ ] Public page shows the generic's name for a unit (FR-PUB-01).
- [ ] Settings: the Types section goes.

## M9 — Go live

First real use. Everything in the requirements that is built is built; going live buys feedback while the inventory is
fresh from the labelling walk.

- [ ] Put the nightly `gear-backup` in the host's cron, and rehearse a restore once ([deploy.md](deploy.md#restoring))
- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.

## M15 — A desk layout

The phone is for the locker. The desk is for the Quartermaster's paperwork: reports, reservations, and data entry
(NFR-USE-10). Nothing here changes the phone; a wide window gets a different home and a different arrangement of the
same data. Reservations are planned at a desk and packed at the locker, so their pages come first.

- [ ] A sidebar above about 900px carrying the Sections: inventory, what is out, repairs, reservations, locations, stock
      check, users, settings. Alerts (found gear, conflicts) sit at the top, only when non-zero. On a phone the same
      component is the Sections row that exists today.
- [ ] A desk home that opens on exceptions: found reports, conflicts, open repairs, overdue gear, a stock check in
      progress, unsent records; then what is out inline (FR-RPT-01) with holder and event; then upcoming reservations.
- [ ] The inventory as a table: name, units in and out, home, status and holder, flags. Sortable by column. Search and
      filters in one row above it, always open, search focused on load. New item and Scan top right; Scan hidden when
      the browser reports no camera.
- [ ] Reservation form and reservation page in two columns: the gear list on one side, search and browse to add to it on
      the other (S-RES-01). Duplicate stays one click.
- [ ] Item page in two columns: fields and edit on the left, history, repairs, and reservations on the right.
- [ ] Print styles for the desk home and the inventory table, so what is out can be pinned to the locker door.
- [ ] Screens tests for both layouts, and one e2e run at desktop width.

Repairs get the sidebar and the table and nothing more until the group has used them; nobody has tracked repairs before,
so where they get triaged is unknown.

## M16 — Reservations that match what went out

The plan becomes the truth, so Duplicate (FR-RES-10) carries last year's real packing list forward. Per-line events come
first: the other two write them.

- [ ] Gear list edits become per-line events: `item_added`, `item_removed`, `quantity_changed`. Both replays, and
      `vectors/replay/` gains a two-phone case where each adds an extra offline and both survive.
- [ ] `event_corrected` on a movement, mirroring the note correction. Both replays and a vector.
- [ ] Scanning an extra during a reservation session adds it to the gear list, or bumps a full generic line (FR-RES-07).
      It shows in the remaining list as ticked.
- [ ] Reservation page: remaining items that are out under another event or none get one tap to link (FR-RES-17). Below
      the list, a picker for anything else that is out.

## M17 — User guide

Three markdown files under `docs/guide/`, served by the app at `/help` (NFR-USE-11). Offline is not required; if the
build makes it so for free, fine. Each entry is a task in the reader's words, one to three lines, the action first. No
background, no why. One "Help" link, at the foot of Settings and of the desk sidebar. Nothing else points at it.

- [ ] `docs/guide/scouter.md`, before the labelling walk in M9: check out and set the event; check in and where it goes
      back; pack for a reservation; find gear; report damage at check-in; take gear someone else has; plan a
      reservation; the no-signal banner; missing or lost stickers; add an item on a labelling walk; sign in, install, a
      lost phone.
- [ ] `docs/guide/quartermaster.md`, after M15 lands: what is out and overdue; found reports and conflicts; repair
      tickets; stock check; items, generics and units, retire, missing, photos; locations; print codes; users, invites,
      resets, revoking a device; mail; backups, pointing at deploy.md.
- [ ] `docs/guide/assistant.md`, with M18: connect an assistant; what you can ask for; what it will not do; revoke it.
- [ ] A `/help` route that renders the files, with a table of contents. Markdown compiled at build time, no runtime
      parser.
- [ ] The Help link, in Settings and the sidebar.

## M18 — Assistant access (MCP)

Plan only for now. The design is in [architecture.md](architecture.md#assistant-access-mcp).

- [ ] "Connect an assistant" in Settings: opens an `mcp-<ulid>` session, shows the token once, lists it with the devices
      (FR-MCP-01, FR-MCP-02).
- [ ] `/mcp` mounted in the FastAPI app, official SDK pinned, bearer token to the same authenticator.
- [ ] A per-device `device_seq` counter on the server, and a helper that turns a tool call into events and pushes them
      through `sync.push` (FR-MCP-05).
- [ ] Read tools: search items, item with history and units, what is out, reservations and remaining, open repairs,
      locations.
- [ ] Write tools: reservations and their lines; items and missing; tickets and comments; check out and in by item
      (FR-MCP-03). Nothing from FR-MCP-04.
- [ ] `conflicts` in Python, with `vectors/reservations/` shared with the client (FR-MCP-06).
- [ ] Rate limit per token with the existing limiter.
