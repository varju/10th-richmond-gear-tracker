# Bootstrap

Getting the inventory in for the first time. This happens once, over several evenings, and it is the largest single
piece of work in the project.

## S-BOOT-06 Stand the server up

A volunteer installs Gear Tracker on the box in their basement. They create the first Admin from the command line, point
the group's domain at it, and hand out an invite link.

- The first Admin is made at the command line; there is no open sign-up
- The domain is the group's, so the server can move later without reprinting stickers
- Invites are links the Admin passes on; the server sends no email

Covers: FR-USR-12, FR-USR-13, FR-TAG-13, NFR-DEP-09

## S-BOOT-01 Set up the group

The Quartermaster creates the group, adds the three storage locations (Cold locker, Warm locker, Garry Point yard), and
invites two Scouters to help.

- Locations are named and editable
- Sub-locations are free text on each item, not a list to configure
- Invited Scouters can sign in and start work immediately

Covers: FR-SET-01, FR-SET-02, FR-SET-03, FR-USR-01, FR-USR-04

## S-BOOT-02 Print a sheet of codes

The Quartermaster generates a PDF of unassigned codes and prints it onto Avery 6576 stock.

- The sheet contains codes not yet bound to anything
- Each label shows the QR code and the group name, nothing else
- The layout matches the sticker sheet without manual adjustment

Covers: FR-TAG-02, FR-TAG-03

## S-BOOT-03 The labelling walk

A Scouter stands in the Cold locker with a phone and a sheet of stickers. They pick up a tent, stick a code on it, scan
it, and type its name. Then the next item.

- Scanning an unassigned code offers to create a new item
- The new item can be named and given a home in the same screen
- The next scan follows immediately, with no return to a menu
- This works with no signal; the locker has none

Covers: FR-TAG-07, FR-INV-01, FR-INV-02, FR-OFF-01

## S-BOOT-04 Two people labelling at once

Two Scouters work different lockers on the same evening, both offline. Neither sees the other's work until they get home
and their phones sync.

- Both sets of items appear after sync, with nothing lost
- Neither phone overwrites the other's work

Covers: FR-OFF-05, FR-OFF-02

## S-BOOT-05 Unlabelled gear

Some gear is too small or too wet to label. It is still entered by hand and found by search.

- An item can be created without a code
- A code can be bound to it later

Covers: FR-INV-01, FR-TAG-07
