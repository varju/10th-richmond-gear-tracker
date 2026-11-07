# Tasks

What is next. See [architecture.md](architecture.md) for how it is built, and [stories/](stories/) for how it is used.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

---

## Tests

- [ ] Fix the flaky `test_deleting_an_item_releases_its_codes` in `tests/test_assistant.py`. It failed once in a full
      run (a released code still showed as bound), then passed five reruns. Cause: the setup binds as device `server`
      and `delete_item` releases as `mcp-…`; in the same millisecond, `mcp-…` sorts first, so the release replays before
      the bind. The app is right to break a tie by device. Plan: write the setup events a second in the past
      (`append_server(now=…)`), and fix other tests that mix `append_server` with an assistant write straight after.
- [ ] Fix the flaky "signed in already, a link says who is signed in" in `client/src/ui/Join.test.tsx`. It failed once
      in a full run, then passed three runs on its own and the next full run. Likely cause: the button's handler is not
      awaited, and `setMeta` updates `store.meta` only after its IndexedDB write, so the check on `store.meta.token`
      straight after the click races it. Plan: wait for the token to clear (`waitFor`) before the checks after the
      click, and look for the same pattern in the other tests in `Join.test.tsx`.
- [ ] Fix the flaky "an Admin merges a duplicate into the item it doubles, and lands on the survivor (FR-INV-13)" in
      `client/src/ui/ItemPage.test.tsx`. It failed once in a full run: `merged_into` was still undefined right after a
      `waitFor` on the pathname. It then passed later full runs. The merge is saved before the page moves, and no sync
      runs in the test, so the cause is not clear from the code. Plan: run the file about 30 times while the machine is
      kept busy, and record the full error and the tests run before it. Fix the cause found, not with a longer wait. If
      it never fails, leave this open with a note to capture the error next time.
- [ ] Fix the flaky "a pool page shows owned, in, and out by holder, and moves by count (FR-INV-36, FR-OUT-22,
      FR-OUT-23)" in `client/src/ui/PoolItem.test.tsx`. It failed once in a full run, then passed later full runs. The
      error was not captured. It may be timing, as the machine was busy with other work. Plan: run the file about 30
      times while the machine is kept busy, and record the full error and the tests run before it. Fix the cause found,
      not with a longer wait. If it never fails, leave this open with a note to capture the error next time.

## Groups of items

- [ ] Question to consider: A canoe trailer is both storage and an item that can be checked out. Today its contents
      still show as in at the yard when it is out. Deferred until the group has used pools for PFD bags.

## UI

- [ ] Check out screen on iOS: Allow number pad to be hidden after entering the quantity for a counted stack. Cause: the
      pool panel's **How many** takes focus at once, the iPhone number pad has no Return or Done key, and tapping the
      page does not blur it. Plan: make the panel a form using `useKeyboardForm`, so a tap off the field closes the pad
      and the move button scrolls above it; keep the autofocus. Do the same for other phone screens with a number box.

## User testing feedback

- [ ] Adding a unit: offer to assign a QR code straight away. It is the likely next step and costs too many clicks now.
      Deferred: it is already two taps (**Add a unit**, then **Add QR code**), so a prompt on the new unit's page is
      easier to spot but saves none. Fewer taps means opening the scanner straight after adding, with a way to skip, or
      a second "Add a unit and scan" button. Scanning an unassigned sticker and picking **Add a unit of…** already does
      both in one step. Waiting on more user testing.
- [ ] Some saves ask for more confirmation than they need, for example converting an item to a generic. Review which
      saves confirm and make them consistent. Plan: confirm only what the app cannot undo (NFR-USE-07). Check each
      confirm in turn (delete item, mark missing, counted stack, single item, several of these, photo, note, ticket,
      reservation cancel, account); drop it where an undo exists and is easy to find. Those that stay use one pattern:
      the same button turns to a warning "Really …?" and a second tap does it.
- [ ] iPhone check-out: after picking an event, changing it does not show the autocomplete until the page is scrolled
      sideways. Cause: in `SessionEvent` (`client/src/ui/Scan.tsx`) the suggestion list sits inside the one-line
      `.session` flex row, so it lands past **Clear**, off screen. Plan: show the suggestions on their own full-width
      line under the bar, as `EventPicker` does, with a test that they are outside the row.
- [ ] An event created during check-out should be a real event, the same as a precreated reservation. No "Add" step
      afterwards. Today a typed name only labels moves; the Reservations screen later offers it (FR-RES-28) and one tap
      makes the reservation (FR-RES-31). Plan: **Create** at check-out (session bar and first picker) makes the
      reservation at once, offline, starting and ending today. A later check-out under the same name while its gear is
      still out joins it and moves its end date out. Moves under it join its gear list. `check_out` in `assistant.py`
      does the same. FR-RES-28 stays for older app builds until none make unplanned events. Two offline phones may each
      make one of the same name; note it, do not solve it here.
- [ ] Back button revisits screens already seen. Example: add a generic item, add an instance, add a QR code. Back shows
      the instance twice before the generic. Cause: after binding, the scanner replaces itself with the item page
      (`Scan.tsx`) instead of going back to the one under it. Plan: a screen that finishes and returns where it came
      from calls `back()`, opening the page only when arrived cold. Check the other finishing screens (Bind, AnotherOf,
      edit, merge, change). Test the example: Back goes unit to generic, and the unit page shows its new code.
- [ ] Add a duplicate-item button that opens an editable copy before saving, for items that differ only slightly (a
      title, say). Plan: **Duplicate…** on an item page opens New item filled from it: name, categories, home, shelf,
      description, purchase details. Not copied: code, photos, history, notes, tickets, status, merge. Units have no
      Duplicate (Add a unit covers it); a stack copies with a blank count. No MCP tool (`create_item` covers it); add a
      Won't row saying so. One new requirement for the button.
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
- [ ] Generic items don't have their own purchase date today, only their parent generic does. The parent's date should
      be used as a default, but we should be able to override per item. Plan: a unit may have its own purchase date;
      unset, it shows the generic's, marked as from the generic. Edit has a **Purchased** box (empty means the
      generic's). Several of these: the date goes to the generic, units start with none. Back to single (FR-INV-33,
      reword): the unit's own date wins, else the generic's. New units start with none. CSV shows the date in use and
      where it came from. `update_item` accepts a unit's date; `get_item` says where it came from. One new requirement.
- [ ] Event gear list: offer check-out order as a sort option, if people miss it. Deferred until someone asks. Plan: a
      **Sort** switch on the event page, Name or Checked out, remembered per phone.
- [ ] Improve support for long term loans. e.g. our troop Scouter has the scout flagpole and badge box at home for the
      whole school year. We still want to know where that gear is, but perhaps don't want to see it on the "What's out"
      screen by default. Plan: a person can be an item's home ("Kept by Sam"), as well as a location and shelf. The gear
      is in, at Sam's, so it is not on What's out and never overdue. Taking it to an event is a normal check-out;
      check-in returns it to Sam. The Home filter offers people too. `update_item` takes a person as home. To settle
      when built: what happens to gear kept by someone made inactive.
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
