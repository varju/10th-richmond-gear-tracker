# Tasks

What is next. See [architecture.md](architecture.md) for how it is built, and [stories/](stories/) for how it is used.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

---

## Groups of items

- [ ] Question to consider: A canoe trailer is both storage and an item that can be checked out. Today its contents
      still show as in at the yard when it is out. Deferred until the group has used pools for PFD bags.

## User testing feedback

- [ ] Adding a unit: offer to assign a QR code straight away. It is the likely next step and costs too many clicks now.
      Deferred: it is already two taps (**Add a unit**, then **Add QR code**), so a prompt on the new unit's page is
      easier to spot but saves none. Fewer taps means opening the scanner straight after adding, with a way to skip, or
      a second "Add a unit and scan" button. Scanning an unassigned sticker and picking **Add a unit of…** already does
      both in one step. Waiting on more user testing.
- [ ] "What did I miss compared to event X?" Compare what is checked out for the current event with a previous event, to
      spot forgotten gear. Needs a requirement and an MCP tool in `assistant.py`. Deferred. Draft plan: **Compare
      with…** on an event's page lists what went out for the past event but not yet for this one, from the movement log
      by event name and dates; `compare_events` in `assistant.py`. Open question: compare a generic's units by count or
      unit by unit.
- [ ] Event gear list: offer check-out order as a sort option, if people miss it. Deferred until someone asks. Plan: a
      **Sort** switch on the event page, Name or Checked out, remembered per phone.
- [ ] Consider whether there are too many buttons for beginners. Some of our Scouters likely just want to check gear in
      and out, and don't need all the extra capabilities related to managing the gear. Plan: tidy for everyone, not a
      mode or a role. Each screen keeps everyday actions in view; rare ones go under one **More…**, shut by default.
      Research first: 1. Count the live log's event types over recent months (read-only, `read_audit_log`), split by
      Admin and User, and assistant (`mcp-…` devices) from phones. Field changes say which field, so edits show which
      parts of the form are used. Packing carries the reservation id; runs of check-outs seconds apart suggest the
      scanner. 2. Mark each item-page action everyday or rare from those counts. 3. Watch two or three Scouters on a
      Friday night for what the log cannot show: searches, filters, screens opened and left, taps cancelled. Do not add
      tap tracking. 4. Then tidy.

      Steps 1 and 2 done (log from 2026-09-02 to 2026-11-02, 2,313 events). One Admin made 95% of them, mostly setup:
      field changes 1,075 (home 288, category 236, name 179, merge 119, delete 79, number and parent 122), created
      788 (479 items, 256 codes). Users made 50 events in all, almost only check-outs (18) and QR codes (14). Moves:
      145 check-outs, 71 check-ins, 67 event corrections, 42 gear-list additions. Only 18 check-out runs (2 to 4 within
      10 s) suggest the scanner; most check-outs are one at a time. Rare: recount 8, photos 7, notes 5, cleaning 5.
      Everyday on an item page: check out, check in, change event, add QR code. Rare: edit, recount, photos, notes, send
      home to clean, merge, several of these, single item, counted stack, duplicate, delete. The log says little about
      Users yet, so step 3 matters: watch two or three Scouters before tidying.

- [ ] Consider how we could make better use of the pictures. e.g. could the picture be shown during checkout so you can
      be sure you have the right item? If there's only one picture, should that be the item's thumbnail? Deferred.
      Photos are online only (FR-INV-11), so a photo at check-out in a locker would mostly fail to load. Draft plan: the
      offline copy carries one small thumbnail per item (first photo unless one is picked; a unit falls back to its
      generic's), shown on the scan card, the item page and the list. Needs FR-INV-11 reworded.
