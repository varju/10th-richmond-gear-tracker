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

## Groups of items

- [ ] Question to consider: A canoe trailer is both storage and an item that can be checked out. Today its contents
      still show as in at the yard when it is out. Deferred until the group has used pools for PFD bags.

## UI

- [ ] As quartermaster, how can I find items that have no QR code, or that have no location or shelf set?
- [ ] Check out screen on iOS: Allow number pad to be hidden after entering the quantity for a counted stack
- [ ] Edit item > We have several > Give count immediately?
- [ ] How can we easily mark items as given to parents to take home and clean, when parents don't have their own
      accounts?
