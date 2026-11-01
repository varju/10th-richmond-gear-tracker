# Tasks

What is next. See [architecture.md](architecture.md) for how it is built, and [stories/](stories/) for how it is used.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

---

## Reservations follow-ups

- [ ] **Change the session event from the item page.** Packing for two events at once from a desktop has no direct way
      to switch: the item page shows the event with no way to change it, and the inventory table hides Scan with no
      camera. Add **Change** beside the event above **Check out**, using the event question's picker (last used and
      today's events in one tap). Earlier moves stay under the old event, or get the "Also change" question as on Scan
      (FR-OUT-40); decide which.
- [ ] Bug: Counted items checked out for an event not listed on Reservations screen
- [ ] Need to be able to see what items are out for an event
- [ ] "Out with no reservation" is not necessary text. An adhoc event defined while checking gear out is just as good as
      a prescheduled reservation
- [ ] "Nothing planned" is confusing text. Consider simplify to "No events" and hiding text entirely as soon as an event
      of any kind is defined
- [ ] Move the Reservations button up to above Reports

## Tests

- [ ] Fix the flaky `test_deleting_an_item_releases_its_codes` in `tests/test_assistant.py`. It failed once in a full
      run (a released code still showed as bound), then passed five reruns. Likely cause: events written in the same
      millisecond replay out of order.
- [ ] Fix the flaky "Only new ones leaves the earlier moves as they were (FR-OUT-40)" in
      `client/src/ui/ScanMove.test.tsx`. It failed once in a full run, then passed three runs on its own and two more
      full runs. Cause not yet known.

## Groups of items

- [ ] Question to consider: A canoe trailer is both storage and an item that can be checked out. Today its contents
      still show as in at the yard when it is out. Deferred until the group has used pools for PFD bags.

## UI

- [ ] As quartermaster, how can I find items that have no QR code, or that have no location or shelf set?
- [ ] Status column is blank for countables, with actual status on next line. Why?
- [ ] Check out screen on iOS: Allow number pad to be hidden after entering the quantity for a counted stack
