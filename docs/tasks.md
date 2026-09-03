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

- [ ] Check the printed sheet against real Avery 6576 stock and fix `labels.py` if the margins are off (FR-TAG-02)

## M7 — Movement

The vertical slice is built. What is left needs a phone.

- [ ] End-to-end test on a real phone with wifi and data turned off

## M20 — Second round of phone feedback

From using the app at 10thrichmond.ca/gear. Fixes first, then wording, then the screens. Answers to the open questions
are folded into each task.

### Fix

- [ ] Help says "No guide was built into this copy" in the deployed app. `.dockerignore` drops `docs/`, so the client
      stage never sees `docs/guide/`, and the `gear-guide` plugin in `vite.config.ts` skips a missing file without a
      word. Copy `docs/guide/` into the client stage, and make the build fail when no section is found.

### Wording

- [ ] Rename **Take out** to **Check out** and **Bring back** to **Return**, everywhere a person reads it: the home
      buttons and hint, the scan mode labels, the card button in Return mode, the "Checked in" flash and history lines
      (now "Returned"), the guide, the stories, FR-OUT-06, and architecture.md. Sweep for substrings too ("take out or
      bring back", "taken out", "brought back") so nothing is half renamed. Assistant tool names (`check_in`) stay.

### Navigation

- [ ] One header on every screen, phone and desk: back where there is a step back, the title, and the menu button. The
      menu opens from any screen, not only Home. Home is its first entry, and tapping the title also goes home.
- [ ] The phone menu and the desk sidebar share one list, with no counts: Home, All items, Reports, Reservations, Stock
      check, Users (Admins), Settings, Help, Sign out. What is out and Needs repair stay inside Reports.
- [ ] Menu rows read like a settings list: left-aligned, full width, one per line, a rule between. `button.link` centres
      its text unless told otherwise; the sidebar already sets `text-align: left`.
- [ ] Delete the Locations pages and the `/locations` routes. Move FR-INV-10 to Won't, replaced by the location and
      shelf filters on All items. Drop "Browse by location" from the guide (scouter.md, quartermaster.md) and
      stories/reports.md.

### Settings

- [ ] Settings becomes a list. At the top: who is signed in, the sync line, Sync now. Then one link per section, each
      its own page with back to Settings: Users, Mail, Group, Locations, Categories, Print codes, Export and import,
      Your devices, Assistant. Sign out leaves Settings; it lives in the menu, and takes the unsent-records guard with
      it.

### Item page

- [ ] Every button at the foot of the item page has the same size and weight. No `minor` there.
- [ ] Bought, Code, Added and Modified leave the facts list for a closed **Details** fold, like History and Changes.
      Both the item page and the generic's page.

### New item

- [ ] Remove supplier everywhere: the form, `boughtLabel`, the audit labels, `ItemInput`, the server model, the CSV
      columns and import, the assistant tool, the demo fixture, and FR-INV-12. Old events still carry a `supplier`
      field; replay in both languages ignores it, and a vector in `vectors/replay/` proves it. The log is not rewritten.
- [ ] The hint under "We have several of these" indents to the checkbox's label, so it reads as belonging to the box.
- [ ] "Keep these values as a template" is shown only when "Add another after saving" is ticked, and is renamed "Copy
      values above".
- [ ] The category list on the item form ends with **New category…**, for anyone signed in. It adds the category in
      place, offline like Settings does, and ticks it. The server already accepts category events from any role; only
      the Settings screen is Admin-only.

## M9 — Go live

First real use. Everything in the requirements that is built is built; going live buys feedback while the inventory is
fresh from the labelling walk.

- [ ] Put the nightly `gear-backup` in the host's cron, and rehearse a restore once ([deploy.md](deploy.md#restoring))
- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.
