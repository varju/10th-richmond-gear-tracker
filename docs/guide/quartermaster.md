# Quartermaster

## What is out

Open What is out. It groups every item that is out by who has it, and names the home, the event, and how many days it
has been gone. On a computer the sections sit down the left of every screen, and the home screen lists these rows
without opening anything. Print that page and the list goes on the locker door.

## Gear that is gone too long

In Settings, fill in "Flag gear out longer than (days)". Items past it are badged Overdue in What is out, and counted on
the computer home screen. Leave the field blank for no flagging; the period is one for the whole group, not per item.

## Found gear

A stranger who scans a sticker can leave a note and a way to reach them. Found gear appears at the top of the sidebar,
and on the computer home screen, while any report is open. Open a report, deal with it, then tap Resolve.

## Two check-outs at once

Two devices with no signal can both check out the same item. Conflicts appears while any is open, on the phone and on
the computer home screen. Each shows both check-outs; tap "It is back" if it came back, or Keep if the second person
still has it. Add a note first if the story needs one.

## Work a repair ticket

Open Needs repair for every open ticket. Open one to read the problem, add a comment, or move it to In progress,
Resolved or Won't fix. Cost, time and parts go in a comment; the date range below the list shows what was raised or
changed in a period.

## A stock check

Open Stock check, pick the location and shelf you are standing at, and tap Start. Scan everything on the shelf.
Misplaced here lists what state says lives elsewhere; Not seen yet lists what should be here. Tap Seen beside a row for
gear with no code, or a sticker you cannot reach. Tap Finish, then Done. A check left running says so on the computer
home screen until you finish it.

## Recount a stack

Open the pool and tap Recount. Say how many are in the locker right now, and why: a delivery, a breakage, a proper
count. It resets what is on the shelf; what people already have out is untouched.

## Add an item

Tap New item, name it, pick a home, and Save. On a computer the button sits above the inventory table, which sorts by
any column and keeps search and the filters in view.

## Several of the same thing

Tick "We have several of these" when you save. The name is stored once and the item in your hand becomes #1. Add the
next one by scanning a fresh code, tapping "Another of…", and picking the name.

## Back to a single item

Open the generic's page and tap "Make this a single item…", then confirm. Works with one unit left, or none: with one,
that unit takes the generic's name, description, categories and purchase details, and its own home stays if it has one;
with none, a fresh item takes them instead. The generic's page still opens, showing where it went.

With no units left, "Make this a counted stack…" is also there: pick a quantity and confirm, and a fresh pool takes the
generic's name, description, categories and purchase details.

## Retire an item

Open the item, tap Edit, and tick Retired. It leaves the lists and cannot be checked out; its history stays. Untick it
to bring it back. Retire is for gear written off.

## Delete an item

Only an Admin, and only for a record made in error: a tent typed in twice, or an item that never existed. Open the item
and tap "Delete for good…", then confirm. It has to be in, and a generic waits until its units have gone. The item
leaves every list, including "show retired", and nothing in the app brings it back.

## Mark an item missing

Open the item and tap Mark missing. It stays in the inventory, drops off What is out, and clears itself at the next scan
or check-in. Missing is for gear that is only lost.

## Photos

Add photos on an item's page and on a repair ticket. They need a connection, and are never stored on the device.

## Locations and categories

Add, rename and delete locations and categories in Settings. One in use will not delete; the message names what is still
there.

## Export and import

In Settings, tap Export to download every item as a CSV. Edit it in a spreadsheet and import it back: a row with an id
changes that item, a row without one adds one, a blank cell clears a field, and an unknown location or category is
created. Preview shows what will change before anything is written. The same from the keyboard with `gear-admin export`
and `gear-admin import`.

## Print a sheet of codes

In Settings, open Print QR codes, set how many sheets, and tap Print QR codes. A PDF opens for Avery 6576 labels. The
codes are unassigned until someone scans one and binds it to gear.

## Invite someone

Open Users in Settings and fill in the name, email and role. If the group has a mail account the server sends the
invite; if not, copy the link and send it however you normally talk. The link is one use.

## A standing join link

Open Users and make a join link, with an expiry of 1, 7, or 30 days, or Never. It shows a URL and a QR code: read it
out, pass it around, or hold up the code for a room of new volunteers to scan at once. Whoever opens it picks a name,
email, and password and gets their own User account. Revoke the link when you are done with it, or let it expire.

Give the link a label, such as "Beaver leaders", so you can tell your live links apart. You can change a label later,
and the link keeps working, so anything already printed is still good.

## Change a role, or end access

Open Users and pick the person. Change their role, or deactivate them to end access; their history stays. The last Admin
cannot be demoted or deactivated.

## Fix a name or a misspelled email

Open Users, pick the person, and edit their name or email. A renamed person sees their new name once they next sign in.

## A forgotten password

Open Users, pick the person, and make a reset link. It is one use, mailed if mail is set up, otherwise copied and passed
on.

## A lost device

Open Users, pick the person, and revoke the device. The account keeps working everywhere else. Anything that device
never sent is gone.

## Your devices

Settings lists the devices and assistants signed in as you. Revoke one you have lost. An Admin can do it for anyone
under Users.

## Send invites by mail

Open Mail in Settings and fill in the server, port, encryption, username, password and the address to send from. Save,
then send a test to your own address. Mail is optional; without it you pass links on by hand.

## Suggest event names from a calendar

Open Calendars in Settings and paste a calendar feed's URL. The server checks it every hour, and the reservation form
and a scanning session then offer its upcoming events for the event name; picking one in the reservation form also fills
the dates. Remove a feed, or tap Refresh now to check it right away. A feed's URL stays on the server, even from an
Admin: the list shows it with the host and path only.

## Backups

The host copies the database and the photo directory on a schedule. Rehearse a restore once so you know it works. See
docs/deploy.md.
