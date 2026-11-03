# Tasks

What is next. See [architecture.md](architecture.md) for how it is built, and [stories/](stories/) for how it is used.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

---

## Tests

- [ ] Fix the flaky `test_deleting_an_item_releases_its_codes` in `tests/test_assistant.py`. It failed once in a full
      run (a released code still showed as bound), then passed five reruns. Likely cause: events written in the same
      millisecond replay out of order.
- [ ] Fix the flaky "Only new ones leaves the earlier moves as they were (FR-OUT-40)" in
      `client/src/ui/ScanMove.test.tsx`. It failed once in a full run, then passed three runs on its own and two more
      full runs. Cause not yet known.
- [ ] Fix the date-dependent `test_the_file_turns_over_at_midnight` in `tests/test_app.py`. It failed on 2026-11-01, the
      day daylight saving ended: the rolled file was named 2026-10-30, not 2026-10-31. Likely cause, not confirmed: it
      takes "yesterday" as now minus a flat 86,400 seconds.
- [ ] Fix the flaky "signed in already, a link says who is signed in" in `client/src/ui/Join.test.tsx`. It failed once
      in a full run, then passed three runs on its own and the next full run. Cause not yet known.

## Groups of items

- [ ] Question to consider: A canoe trailer is both storage and an item that can be checked out. Today its contents
      still show as in at the yard when it is out. Deferred until the group has used pools for PFD bags.

## UI

- [ ] As quartermaster, how can I find items that have no QR code, or that have no location or shelf set?
- [ ] Check out screen on iOS: Allow number pad to be hidden after entering the quantity for a counted stack
- [ ] Edit item > We have several > Give count immediately?

## User testing feedback

- [ ] Adding a unit: offer to assign a QR code straight away. It is the likely next step and costs too many clicks now.
- [ ] Check-out gives too little confirmation. A user did not realise the item was already checked out.
- [ ] Some saves ask for more confirmation than they need, for example converting an item to a generic. Review which
      saves confirm and make them consistent.
- [ ] iPhone check-out: after picking an event, changing it does not show the autocomplete until the page is scrolled
      sideways.
- [ ] An event created during check-out should be a real event, the same as a precreated reservation. No "Add" step
      afterwards.
- [ ] Back button revisits screens already seen. Example: add a generic item, add an instance, add a QR code. Back shows
      the instance twice before the generic.
- [ ] Generics: allow adding another instance while viewing an existing instance.
- [ ] Add a duplicate-item button that opens an editable copy before saving, for items that differ only slightly (a
      title, say).
- [ ] Consumables, for example propane tanks that are refilled. An item can have an optional empty (base) weight.
      Check-in asks for the current weight and infers the amount left. "Unknown" must be allowed when there is no scale.
      Needs a requirement and an MCP tool in `assistant.py`.
- [ ] "What did I miss compared to event X?" Compare what is checked out for the current event with a previous event, to
      spot forgotten gear. Needs a requirement and an MCP tool in `assistant.py`.
- [ ] "Enter QR code manually" shows the internal ID, which is not printed on the sticker. Ask for what the sticker
      shows, or drop the ID from the screen. Check what is printed first.
- [ ] When creating a generic item, if I say we have several I should be able to indicate the count we have.
- [ ] Generic items don't have their own purchase date today, only their parent generic does. The parent's date should
      be used as a default, but we should be able to override per item.
- [ ] Generics render differently in All Items view than Countables. Countables have their in/out under Status, while
      Generics use an inconsistent method of counting. Make Generics render the same, using in/out instead of units/in,
      in the Status column. Put the collapse/expand arrow somewhere more subtle, in the main row.
- [ ] Event gear list: offer check-out order as a sort option, if people miss it.
- [ ] Improve support for long term loans. e.g. our troop Scouter has the scout flagpole and badge box at home for the
      whole school year. We still want to know where that gear is, but perhaps don't want to see it on the "What's out"
      screen by default.
- [ ] Consider whether there are too many buttons for beginners. Some of our Scouters likely just want to check gear in
      and out, and don't need all the extra capabilities related to managing the gear.
- [ ] Consider how we could make better use of the pictures. e.g. could the picture be shown during checkout so you can
      be sure you have the right item? If there's only one picture, should that be the item's thumbnail?
