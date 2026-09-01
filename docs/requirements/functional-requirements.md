# Functional requirements

Priorities are Must, Should, Could, Won't.

---

## 1. Setup and configuration (SET)

| ID | Priority | Requirement |
|---|---|---|
| FR-SET-01 | Must | Holds the inventory for one Scout group. The group name appears on labels and printed reports. |
| FR-SET-02 | Must | The Quartermaster can define **categories** (tents, stoves, tarps, cooking gear) and reassign items between them. |
| FR-SET-03 | Must | The Quartermaster can define **storage locations** and reassign items between them. Today these are Cold locker, Warm locker, and Garry Point yard. |
| FR-SET-03a | Must | Each location has named **sub-locations**: numbered shelves, or a specific trailer. |
| FR-SET-03b | Must | Rename or renumber a sub-location without touching the items in it. |
| FR-SET-04 | Must | Deleting a category or location still in use is blocked. The message names the items blocking it. |
| FR-SET-05 | Should | The Quartermaster can define **condition** values (new, good, worn, needs repair, retired). |
| FR-SET-06 | Should | Import the initial inventory from CSV. The first load is 200+ items; typing them one by one is not acceptable. |
| FR-SET-07 | Could | Sub-locations nest more than one level (trailer > front bin > pouch). Only if a single level proves too coarse. |

## 2. Inventory (INV)

| ID | Priority | Requirement |
|---|---|---|
| FR-INV-01 | Must | Create, view, edit, and retire a gear item. Fields: name, category, home location, home sub-location, condition, quantity, notes, tags. |
| FR-INV-01a | Must | **Home** is where an item belongs when not out, e.g. "Warm locker / shelf 4". Distinct from where it is right now. |
| FR-INV-02 | Must | Retire an item rather than delete it, so history survives. Retired items are hidden and cannot be checked out. |
| FR-INV-03 | Must | Two kinds: **tracked assets** (one thing, one label, checked out individually) and **consumables** (a stock count, e.g. fuel canisters, drawn down). |
| FR-INV-04 | Must | Consumable stock decrements on issue and can be adjusted manually with a reason. |
| FR-INV-05 | Must | Search by name. Results appear as the user types, on 500 items. |
| FR-INV-06 | Must | Filter the list by category, location, sub-location, condition, and status (in, out, reserved, in repair). |
| FR-INV-06a | Should | Browse by location then sub-location, to answer "what belongs on shelf 4?". This is the shape of a stock check. |
| FR-INV-07 | Must | The item page shows status and holder, home, access history, repair history, and upcoming reservations. |
| FR-INV-08 | Should | Attach photos. Phone photos are resized before storage. |
| FR-INV-09 | Should | Record purchase date, price, and supplier, for insurance and replacement planning. |
| FR-INV-10 | Should | Merge duplicate items. Both histories move to the survivor. |
| FR-INV-11 | Should | Group items into **kits** ("Patrol box 3": stove, 2 pots, lighter) and check the kit out in one action. |
| FR-INV-12 | Could | Low-stock alert on consumables when the count drops below a per-item threshold. |
| FR-INV-13 | Could | Bulk edit: change category, home, or condition on several items at once. |

## 3. Labels and QR codes (TAG)

| ID | Priority | Requirement |
|---|---|---|
| FR-TAG-01 | Must | Every tracked asset has a unique, permanent ID in a QR code. |
| FR-TAG-02 | Must | Generate a printable label for a single item from its detail page. |
| FR-TAG-03 | Must | Generate labels in bulk as a PDF laid out for Avery 6576 (1.75" x 1.25"). Other layouts are configurable. |
| FR-TAG-04 | Must | Labels carry the QR code plus the group and item name in text, so gear is identifiable without a phone. |
| FR-TAG-04a | Won't | Print the home on the label. Homes change, labels do not; a stale shelf number is worse than none. Show it in the app (FR-OUT-07a). |
| FR-TAG-05 | Must | Reprint a label for an item that already has one, using the same ID. |
| FR-TAG-06 | Must | Scanning a QR code with the phone camera, in the browser, opens the matching item. |
| FR-TAG-07 | Should | Adopt a pre-printed sticker: scan an unknown code, bind it to an existing item. Avoids lock-in to one supplier. |
| FR-TAG-08 | Should | Print pre-generated codes to stick on gear now and bind to records later. |
| FR-TAG-09 | Could | Scanning a code that is not in the system offers to create the item on the spot. |

## 4. Check-out and check-in (OUT)

The core workflow. It happens in an unheated locker or an outdoor yard, on a phone, in gloves.

| ID | Priority | Requirement |
|---|---|---|
| FR-OUT-01 | Must | Check out an item by scanning its label. |
| FR-OUT-02 | Must | Check out an item found by search or browse, no scan. Not all gear is labelled. |
| FR-OUT-03 | Must | **Batch check-out**: scan items into a pending list, confirm the list in one action. No confirmation tap per scan. |
| FR-OUT-04 | Must | Check-out records who, when, and optionally which event. |
| FR-OUT-05 | Must | Check gear back in by scan or by search, individually or as a batch. |
| FR-OUT-06 | Must | Anyone can check in gear someone else took. It comes back with whoever drove the trailer. |
| FR-OUT-07 | Must | Add a note during check-in ("zipper broken on tent bag"), and raise a repair ticket in the same step. |
| FR-OUT-07a | Must | Check-in shows the item's home prominently, so the Scouter knows where to put it. This is the point of sub-locations. |
| FR-OUT-07b | Should | After a batch check-in, show a **put-away list**: returned items grouped by home, in walking order. |
| FR-OUT-07c | Should | Change an item's home during check-in, when gear is deliberately restowed. Confirmed, not silent. |
| FR-OUT-08 | Must | Checking out gear already out shows who has it and offers to transfer. |
| FR-OUT-09 | Should | Set an expected return date at check-out. |
| FR-OUT-10 | Should | Flag gear out past its expected return, or out longer than a set period. |
| FR-OUT-11 | Should | Change condition during check-in without leaving the flow. |
| FR-OUT-12 | Could | Check out to a named person who is not a system user (a youth, a parent). |

## 5. Reservations (RES)

| ID | Priority | Requirement |
|---|---|---|
| FR-RES-01 | Must | Create a reservation with an event name, a date range, and a list of items. |
| FR-RES-02 | Must | Block a conflicting reservation. The message names the conflicting event. |
| FR-RES-03 | Must | Check out all of a reservation's items in one action, and check them all back in on return. |
| FR-RES-04 | Should | Warn, but allow, when a reserved item has an open repair ticket. |
| FR-RES-05 | Should | Warn when checking out an item someone else reserved for an overlapping date. |
| FR-RES-06 | Should | Duplicate a reservation, carrying the gear list over. Camps repeat annually. |
| FR-RES-07 | Should | Reserve a quantity of a consumable, not just tracked assets. |
| FR-RES-08 | Could | Calendar view of reservations alongside the list view. |
| FR-RES-09 | Could | Reserve a category ("4 tents"), resolved to specific items at check-out. |

## 6. Repairs and maintenance (REP)

| ID | Priority | Requirement |
|---|---|---|
| FR-REP-01 | Must | Raise a repair ticket against an item, with a description and optional photo. |
| FR-REP-02 | Must | Any signed-in user can raise a ticket, read-only included. |
| FR-REP-03 | Must | A ticket moves through states: open, in progress, resolved, won't fix. |
| FR-REP-04 | Must | Ticket history stays on the item after the ticket closes. |
| FR-REP-05 | Must | Items with an open ticket are flagged in lists and at check-out. |
| FR-REP-06 | Should | Comment on a ticket, so the Quartermaster can ask for detail and get a reply. |
| FR-REP-07 | Should | Assign a ticket to a person. |
| FR-REP-08 | Should | Record repair cost, time spent, and parts used. |
| FR-REP-09 | Could | Scheduled maintenance reminders: air tents each spring, service stoves annually. |

## 7. Public pages (PUB)

Reachable by scanning a label, with no sign-in.

| ID | Priority | Requirement |
|---|---|---|
| FR-PUB-01 | Must | Scanning while signed out shows the item name, the group name, and how to reach us. No member names, prices, or history. |
| FR-PUB-02 | Must | Anyone can report the item found, with a note and optional contact detail. |
| FR-PUB-03 | Must | Found reports reach the Quartermaster in the app, as something to act on. |
| FR-PUB-04 | Should | Per-item toggle to allow raising a repair ticket from the public page. |
| FR-PUB-05 | Should | Public submissions are rate-limited and spam-protected. |
| FR-PUB-06 | Won't | Public check-in and check-out. We will not record gear movement by unidentified people. |

## 8. Users, roles, and access (USR)

| ID | Priority | Requirement |
|---|---|---|
| FR-USR-01 | Must | Users sign in with an account tied to an email address. |
| FR-USR-02 | Must | Four roles: **Owner** (everything, including billing and hosting), **Admin** (everything except owner-only settings; manages users), **User** (add and edit items, check in and out, reserve, raise tickets; cannot change categories, locations, or users), **Read-only** (check in and out, raise tickets; cannot add, edit, or delete items or reservations). |
| FR-USR-03 | Must | Admins can invite, deactivate, and change the role of users. |
| FR-USR-04 | Must | An audit log records who changed what, and when: item edits, check-outs, check-ins, role changes. |
| FR-USR-05 | Should | Sessions last weeks on a trusted device. Nobody types a password in a cold locker. |
| FR-USR-06 | Should | Shared-device mode: the device stays signed in and the user picks their name from a list before a batch. |
| FR-USR-07 | Could | Sign in with Google, to avoid managing passwords. |

## 9. Reports and data (RPT)

| ID | Priority | Requirement |
|---|---|---|
| FR-RPT-01 | Must | One report: what is out, and who has it. The group's biggest pain point today. |
| FR-RPT-02 | Must | Export the full inventory to CSV. No lock-in, and our backup of record. |
| FR-RPT-03 | Must | Export any filtered list to CSV. |
| FR-RPT-04 | Should | Overdue report: gear out past its expected return date. |
| FR-RPT-05 | Should | Repair report: open tickets, and repair history over a date range. |
| FR-RPT-06 | Should | Valuation: total purchase value by category and location, for insurance. |
| FR-RPT-07 | Could | Usage: which gear moves, and which has not left the locker in a year. |
| FR-RPT-08 | Could | Printable pick list for a reservation, grouped by home so one walk collects everything. Also a paper fallback. |
| FR-RPT-09 | Should | Misplaced gear: items in, but not at their home. Falls out of a stock check. |
| FR-RPT-10 | Could | Printable contents sheet per sub-location, listing what belongs there. |

## 10. Offline and sync (OFF)

Applies if we adopt the offline model. See
[NFR-DEP](non-functional-requirements.md#1-deployment-model-dep).

| ID | Priority | Requirement |
|---|---|---|
| FR-OFF-01 | Must | Check-out, check-in, and search work with no network. These happen at the lockers. |
| FR-OFF-02 | Must | Offline work is stored on device and syncs when a connection returns, with no user action. |
| FR-OFF-03 | Must | The user can see whether they are online, and whether anything is waiting to sync. |
| FR-OFF-04 | Must | Two devices acting offline on one item lose nothing. Movements are an ordered event log per item, not status overwrites. |
| FR-OFF-05 | Should | Conflicts a machine cannot resolve queue for the Quartermaster, showing both versions. |
| FR-OFF-06 | Should | Sync on a slow connection without re-downloading the whole inventory. |
