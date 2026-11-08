# Quartermaster

## Keeping track

### What is out

Open **Reports** > **What is out**. It groups every item that is out by who has it, and names the home, the event, and
how many days it has been gone. On a computer, the home screen shows the same list. To see only one event's gear, open
the report and pick it under **Event**. Print the page and pin it to the locker door.

### Gear that is gone too long

Open **Settings** > **General** and fill in **Flag gear out longer than (days)**. Items past it are badged **Overdue**
in **What is out**, and counted on the computer home screen. Leave the field blank for no flagging; the period is one
for the whole group, not per item.

### Found gear

A stranger who scans a sticker can leave a note and a way to reach them. **Found gear** appears at the top of the
sidebar, and on the computer home screen, while any report is open. Open a report, deal with it, then tap **Resolve**.

### Two check-outs at once

Two devices with no signal can both check out the same item. **Conflicts** appears while any is open, on the phone and
on the computer home screen. Each shows both check-outs; tap **It is back** if it came back, or **Keep** if the second
person still has it. Add a note first if the story needs one.

### Mark an item missing

Anyone can do this. Open the item and tap **Mark missing**. It stays in the inventory, drops off **What is out**, and
clears itself at the next scan or check-in. Missing is for gear that is only lost.

### Work a repair ticket

Open **Reports** > **Needs repair** for every open ticket. Open one to read the problem, add a comment, or move it to
**In progress**, **Resolved** or **Won't fix**. Cost, time and parts go in a comment; the **From** and **To** dates
below the list show what was raised or changed in a period.

An Admin can delete any ticket raised in error: tap **Delete ticket…** twice. It leaves every list and cannot be brought
back.

## Counting

### A stock check

Open **Stock check**, pick the **Location** and **Shelf** you are standing at, and tap **Start**. Scan everything on the
shelf. **Misplaced here** lists gear whose home is somewhere else; **Not seen yet** lists what should be here but has
not been scanned. Tap **Seen** beside a row for gear with no code, or a sticker you cannot reach. Tap **Finish**, then
**Done**. To make a shelf, pick **New shelf…** and type its name. **Belongs here** on a misplaced row makes this shelf
the item's home; **All belong here** does it for every row except gear kept by a person, after asking. A check left
running says so on the computer home screen until you finish it.

### Recount a stack

Open the stack and tap **Recount**. Say how many are in the locker right now. Why is optional: a delivery, a breakage, a
proper count. It resets what is on the shelf; what people already have out is untouched.

### A stack comes back one short

Open the stack and tap **Mark missing**. Pick whose it was if more than one person has some out, and say how many. The
count comes off that person's name, but the group still owns it. The stack's page shows **Missing**, and the Missing
filter finds it. If it turns up, tap **Found** to put it back in. If it is gone for good, tap **Write off**, with a
reason if you like. It leaves the count the group owns.

## Items

### Add an item

Tap **New item**, name it, pick a home, and tap **Save**. On a computer the button sits above the inventory table, which
sorts by any column and keeps search and the filters in view. Click the arrow beside a name to show its units; a search
or filter shows them already.

A home can also be a person: in the home field, pick someone under **Kept by**. Gear kept by Sam shows as "Kept by Sam",
counts as in, and is not on **What is out**. Check it out and in as usual; it goes back to Sam. The **Location** filter
on the list offers people too.

A description can use `**bold**`, `*italic*`, `[a link](https://example.org)` and lines starting with `- ` for a bullet
list. A web address on its own becomes a link too. A backslash before a `*` shows the star as typed.

### Find gear that is not set up

Open **Filters** and set **Needs** to **QR code**, **Location** or **Shelf**. The list shows only gear that lacks it. A
unit shows under its group. The table on a computer has the same filter.

### Several of the same thing

Tick **We have several of these** on **New item**, then pick one:

- **Labelled one by one,** for tents. This saves the name, such as "Tent". Each tent is a unit with its own number and
  code: scan a fresh code, tap **Add a unit of…**, and pick the name. Or open the name's page and tap **Add a unit**. A
  unit's page has **Add another unit**. To make the units at once, give **How many**. Each is numbered from 1 and ready
  for a code. It takes its code from its own page with **Add QR code**. **Filters** > **Needs** > **QR code** lists the
  ones still without. Or scan a fresh code, tap **Add a unit of…**, and pick the name: the code goes on the next unit
  waiting for one.
- **A stack we count,** for mugs. Say how many. Nobody labels each mug; people check out a count.

Starting from a scanned code, the tick saves the name and the item in your hand becomes #1.

An item already saved as one thing? Open it, tap **Edit**, tick the same box, and pick one. For labelled gear, **How
many in all** makes the other units too. It can become a stack only while it is checked in.

### Photos

Add photos on an item's page and on a repair ticket. A photo taken with no signal waits on the device and uploads at the
next sync. Viewing photos needs a connection.

### Two records that are really a group

Two tents entered as separate items? Open one, tap **Group with another item…**, then search for the other and pick it.
Both become numbered units under one name and keep their own history. To move a unit under a different name, open it and
tap **Move to another generic…**.

### A record typed in twice

One tent entered as two items? Only an Admin can fix it. Open the extra record, tap **This is a duplicate record…**,
search for the real one and pick it, and tap **Merge**. The extra record drops off the lists and points at the real one.
**Unmerge** on either page undoes it. Not to be confused with **Duplicate…**, which copies an item into a new one for
gear that differs slightly; nothing is saved until you tap **Save**.

### Gear you weigh, like a propane tank

Edit the item and open **Weighed to see what is left**. Give its **Empty weight** and its **Capacity**, the weight of a
full load of contents. Each has its own **lb** or **kg**. An item with both asks for its weight when it is returned, and
shows what is left. For several of the same thing, set the capacity on the name; each unit sets its own empty weight and
uses the name's capacity unless it has one.

### Bought on

A unit can have its own **Bought on** date. Without one, it shows its name's date.

### Back to a single item

A name with labelled units can go back to being one item when it has one unit left, or none. Open the name's page, tap
**Make this a single item**.

- With one unit left, that unit becomes the item. It keeps its own home.
- With none left, a new item is made.

Either way the item takes the name, description and categories. It keeps its own "Bought on" date, or takes the name's
if it has none. The old page still opens and shows where it went.

With no units left, **Make this a counted stack…** is also there. Pick a quantity and tap it twice, and a new stack
takes the same details. A stack cannot go back, so the second tap asks.

### Retire an item

Open the item, tap **Edit**, and tick **Retired**. It leaves the lists and cannot be checked out; its history stays.
Untick it to bring it back. Retire is for gear written off.

### Delete an item

Only an Admin, and only for an item that never existed. Open the item, tap **Delete for good…**, then tap it again to
confirm. It has to be in, and a generic waits until its units have gone. The item leaves every list, including **Show
retired**, and nothing in the app brings it back.

## People

### Invite someone

Open **Users**, fill in the name, email and role under **Invite someone**, and tap **Invite**. If the group has a mail
account the server sends the invite; if not, copy the link and send it however you normally talk. The link is one use.

### A standing join link

Open **Users**, set **Expires after** to 1, 7 or 30 days, or Never, and tap **Create join link**. It shows a URL and a
QR code: read it out, pass it around, or hold up the code for a room of new volunteers to scan at once. Whoever opens it
picks a name, email, and password and gets their own User account. Tap **Revoke** when you are done with it, or let it
expire.

Fill in **Label**, such as "Beaver leaders", so you can tell your live links apart. You can change a label later, and
the link keeps working, so anything already printed is still good.

A printed code doubles as the way back in. Someone already signed in on their device is sent straight home. Someone
signed out sees **Already have an account? Log in** under the join form.

### Change a role, or end access

Open **Users** and pick the person. Change their **Role**, or tap **Deactivate** to end access; their history stays. The
last Admin cannot be demoted or deactivated.

### Fix a name or a misspelled email

Open **Users**, pick the person, and tap **Edit name or email**.

### A forgotten password

Open **Users**, pick the person, and tap **Reset link**. It is one use, mailed if mail is set up, otherwise copied and
passed on.

### A locked account

Five wrong passwords lock an email for 15 minutes, longer each time it happens again. Every Admin gets an email when it
happens, at most one an hour. Open **Users**, pick the person, and tap **Unlock** to let them try again now.

### A lost device

Open **Users**, pick the person, and tap **Revoke** beside the device. The account keeps working everywhere else.
Anything that device never sent is gone.

### Your devices

**Settings** > **Your devices** lists the devices and assistants signed in as you. Tap **Revoke** beside one you have
lost. An Admin can do it for anyone under **Users**.

## Setup

### Locations and categories

Add, rename and delete them under **Settings** > **Locations** and **Settings** > **Categories**. One in use will not
delete; the message names what is still there.

### Print a sheet of codes

Open **Settings** > **Print QR codes**, set **Sheets**, and tap **Print QR codes**. A PDF opens for US Letter sheets of
32 labels, each 1.75 x 1.25 in. The codes are unassigned until someone scans one and binds it to gear.

### Send invites by mail

Open **Settings** > **Mail** and fill in **Server**, **Port**, **Encryption**, **Username**, **Password** and **Send
from**. Tap **Save**, then **Send a test** to your own address. Mail is optional; without it you pass links on by hand.

### Suggest event names from a calendar

Open **Settings** > **Calendars**, paste a calendar feed's URL into **Feed URL**, and tap **Add feed**. The server
checks it every hour, and the event form and a scanning session then offer its upcoming events for the event name;
picking one in the event form also fills the dates. Tap **Remove** to drop a feed, or **Refresh now** to check it right
away. Once saved, the full link is hidden; the list shows a shortened form.

### Export and import

Open **Settings** > **Export and import** and tap **Download inventory.csv**. Edit it in a spreadsheet and choose it
under **Import a CSV**: a row with an id changes that item, a row without one adds one, a blank cell clears a field, and
an unknown location or category is created. A preview shows what will change; nothing is written until you tap
**Apply**.

## Records

### Read the audit log

Open **Settings** > **Audit log** to see everything that has happened, newest first: gear moved, records edited,
accounts invited and changed. Narrow it by **What happened**, by **Person**, and with **From** and **To** dates.
Deactivated people stay in the log and stay in the list you pick from.

The whole log lives on the server, so this one screen needs a connection. An item's own history is on its page, and
works offline.

### Backups

The host copies the database and the photo directory on a schedule. Rehearse a restore once so you know it works.
