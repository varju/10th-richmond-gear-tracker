# Tasks

What is next. See [architecture.md](architecture.md) for how it is built, and [stories/](stories/) for how it is used.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

---

## Tests

- [ ] Fix the flaky "a pool page shows owned, in, and out by holder, and moves by count (FR-INV-36, FR-OUT-22,
      FR-OUT-23)" in `client/src/ui/PoolItem.test.tsx`. It failed once in a full run, then passed later full runs. The
      error was not captured. It may be timing, as the machine was busy with other work. Plan: run the file about 30
      times while the machine is kept busy, and record the full error and the tests run before it. Fix the cause found,
      not with a longer wait. If it never fails, leave this open with a note to capture the error next time.

## Groups of items

- [ ] Question to consider: A canoe trailer is both storage and an item that can be checked out. Today its contents
      still show as in at the yard when it is out. Deferred until the group has used pools for PFD bags.

## User testing feedback

- [ ] Adding a unit: offer to assign a QR code straight away. It is the likely next step and costs too many clicks now.
      Deferred: it is already two taps (**Add a unit**, then **Add QR code**), so a prompt on the new unit's page is
      easier to spot but saves none. Fewer taps means opening the scanner straight after adding, with a way to skip, or
      a second "Add a unit and scan" button. Scanning an unassigned sticker and picking **Add a unit of…** already does
      both in one step. Waiting on more user testing.
- [ ] Consumables, for example propane tanks that are refilled. An item can have an optional empty (base) weight.
      Check-in asks for the current weight and infers the amount left. "Unknown" must be allowed when there is no scale.
      Needs a requirement and an MCP tool in `assistant.py`. Plan: not propane-only; any item weighed to see what is
      left. An item may have an empty weight and a capacity, each in lb or kg, chosen per item (a unit sets its own
      empty weight; capacity defaults from its generic). Check-in asks for the weight, **Unknown** allowed; a **Weigh**
      action records one any time. Each weight is entered in the item's unit with an lb/kg switch, and is logged as
      typed (number and unit), converted when shown. The page and list show "About 8 lb left (40%)". **Refilled** sets
      it full. New event type (older builds skip it); replay in Python, TypeScript and `vectors/replay/`. MCP:
      `check_in` takes a weight, plus `weigh` and `refilled` tools. Not weighed at check-out. A Low flag is deferred.
      FR-INV-14, 15, 17 and FR-RES-11 (canisters, never built) stay as they are for now.
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
- [ ] Consider how we could make better use of the pictures. e.g. could the picture be shown during checkout so you can
      be sure you have the right item? If there's only one picture, should that be the item's thumbnail? Deferred.
      Photos are online only (FR-INV-11), so a photo at check-out in a locker would mostly fail to load. Draft plan: the
      offline copy carries one small thumbnail per item (first photo unless one is picked; a unit falls back to its
      generic's), shown on the scan card, the item page and the list. Needs FR-INV-11 reworded.
