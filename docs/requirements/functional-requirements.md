# Functional requirements

What the system must do. Priorities are Must, Should, Could, Won't.

---

## 1. Setup and configuration (SET)

| ID | Priority | Requirement |
|---|---|---|
| FR-SET-01 | Must | Hold the inventory for one Scout group. Group name appears on labels and printed reports. |
| FR-SET-02 | Must | The Quartermaster can define **categories** (tents, stoves, tarps, cooking gear) and reassign items between them. |
| FR-SET-03 | Must | The Quartermaster can define **storage locations** and reassign items between them. Today these are Cold locker, Warm locker, and Garry Point yard. |
| FR-SET-04 | Must | Deleting a category or location that is still in use is blocked, with a message naming the items that block it. |
| FR-SET-05 | Should | The Quartermaster can define **condition** values (new, good, worn, needs repair, retired). |
| FR-SET-06 | Should | Import an initial inventory from a CSV or spreadsheet. First load is 200+ items; typing them one at a time is not acceptable. |
| FR-SET-07 | Could | Locations nest one level (Warm locker > shelf 3). |

## 2. Inventory (INV)

| ID | Priority | Requirement |
|---|---|---|
| FR-INV-01 | Must | Create, view, edit, and retire a gear item. Fields: name, category, location, condition, quantity, notes, tags. |
| FR-INV-02 | Must | Retire (soft delete) an item so its history survives. Retired items are hidden from normal lists and cannot be checked out. |
| FR-INV-03 | Must | Two item kinds: **tracked assets** (one physical thing, one label, checked out individually) and **consumables** (a stock count, e.g. fuel canisters, drawn down rather than checked out). |
| FR-INV-04 | Must | Consumable stock decrements on issue and can be adjusted manually with a reason. |
| FR-INV-05 | Must | Search items by name. Results appear as the user types on a list of 500 items. |
| FR-INV-06 | Must | Filter the list by category, location, condition, and status (in, out, reserved, in repair). |
| FR-INV-07 | Must | An item detail page shows: current status and holder, access history, repair history, and upcoming reservations. |
| FR-INV-08 | Should | Attach photos to an item. Photos taken on a phone are resized before storage. |
| FR-INV-09 | Should | Record purchase date, purchase price, and supplier, to support insurance and replacement planning. |
| FR-INV-10 | Should | Merge two items that turn out to be duplicates. History from both is kept on the survivor. |
| FR-INV-11 | Should | Group items into **kits** (e.g. "Patrol box 3" holds a stove, 2 pots, a lighter) and check the kit out as one action. |
| FR-INV-12 | Could | Low-stock alert on consumables when the count drops below a per-item threshold. |
| FR-INV-13 | Could | Bulk edit: select several items and change category, location, or condition in one action. |

## 3. Labels and QR codes (TAG)

| ID | Priority | Requirement |
|---|---|---|
| FR-TAG-01 | Must | Every tracked asset has a unique, permanent ID encoded in a QR code. |
| FR-TAG-02 | Must | Generate a printable label for a single item from its detail page. |
| FR-TAG-03 | Must | Generate labels in bulk as a PDF, laid out for Avery 6576 stock (1.75" x 1.25", 1600 per box). Other Avery layouts are configurable. |
| FR-TAG-04 | Must | Labels show the QR code, the group name, and the item name in text, so a reader can identify gear without a phone. |
| FR-TAG-05 | Must | Reprint a label for an item that already has one, using the same ID. |
| FR-TAG-06 | Must | Scan a QR code with the phone camera in the browser and land on the matching item. |
| FR-TAG-07 | Should | Adopt a pre-printed third-party QR sticker: scan an unknown code and bind it to an existing item. Avoids being locked into one label supplier. |
| FR-TAG-08 | Should | Print a sheet of blank pre-generated codes to stick on gear now and bind to records later. |
| FR-TAG-09 | Could | Scanning a code that is not in the system offers to create the item on the spot. |

## 4. Check-out and check-in (OUT)

This is the core workflow. It happens in an unheated locker or an outdoor yard, on a phone, with gloves on.

| ID | Priority | Requirement |
|---|---|---|
| FR-OUT-01 | Must | Check out an item by scanning its label. |
| FR-OUT-02 | Must | Check out an item found by search or browse, with no scan. Not all gear will be labelled. |
| FR-OUT-03 | Must | **Batch check-out**: scan several items into a pending list, then confirm the whole list in one action. Scanning must not require a confirmation tap per item. |
| FR-OUT-04 | Must | Every check-out records who took the gear, when, and optionally the event or trip it is for. |
| FR-OUT-05 | Must | Check gear back in by scan or by search, individually or as a batch. |
| FR-OUT-06 | Must | Anyone may check in gear that someone else checked out. Gear comes back with whoever drove the trailer. |
| FR-OUT-07 | Must | Add a note during check-in ("zipper broken on tent bag"). A note flagging damage can raise a repair ticket in the same step. |
| FR-OUT-08 | Must | Checking out an item that is already out shows who has it and offers to transfer the holding. |
| FR-OUT-09 | Should | Set an expected return date at check-out. |
| FR-OUT-10 | Should | Flag gear that is out past its expected return, or out longer than a set period with no return. |
| FR-OUT-11 | Should | Change the condition of an item during check-in without leaving the flow. |
| FR-OUT-12 | Could | Check out to a named person who is not a system user (a youth, a parent). |

## 5. Reservations (RES)

| ID | Priority | Requirement |
|---|---|---|
| FR-RES-01 | Must | Create a reservation with an event name, a date range, and a list of items. |
| FR-RES-02 | Must | Block a reservation that conflicts with an existing one for the same item. The message names the conflicting event. |
| FR-RES-03 | Must | From a reservation, check out all its items in one action, and check them all back in on return. |
| FR-RES-04 | Should | Warn, but allow, when a reserved item has an open repair ticket. |
| FR-RES-05 | Should | Warn when someone checks out an item reserved by someone else for an overlapping date. |
| FR-RES-06 | Should | Duplicate a reservation for a future trip, carrying the gear list over. Camps repeat annually. |
| FR-RES-07 | Should | Reserve a quantity of a consumable, not just tracked assets. |
| FR-RES-08 | Could | Calendar view of reservations alongside the list view. |
| FR-RES-09 | Could | Reserve a category rather than named items ("4 tents"), resolved to specific items at check-out. |

## 6. Repairs and maintenance (REP)

| ID | Priority | Requirement |
|---|---|---|
| FR-REP-01 | Must | Raise a repair ticket against an item, with a description and optional photo. |
| FR-REP-02 | Must | Any signed-in user can raise a ticket, including read-only users. |
| FR-REP-03 | Must | A ticket moves through states: open, in progress, resolved, won't fix. |
| FR-REP-04 | Must | Ticket history stays on the item record after the ticket closes. |
| FR-REP-05 | Must | An item with an open ticket is visibly flagged in lists and at check-out. |
| FR-REP-06 | Should | Comment on a ticket, so the Quartermaster can ask for detail and the reporter can reply. |
| FR-REP-07 | Should | Assign a ticket to a person. |
| FR-REP-08 | Should | Record repair cost, time spent, and parts used. |
| FR-REP-09 | Could | Scheduled maintenance reminders (e.g. air out tents each spring, service stoves annually). |

## 7. Public pages (PUB)

Pages reachable by scanning a label, with no sign-in.

| ID | Priority | Requirement |
|---|---|---|
| FR-PUB-01 | Must | Scanning a label while signed out opens a public item page showing the item name, the group name, and how to contact the group. It must not expose member names, contact details, purchase prices, or history. |
| FR-PUB-02 | Must | The public page lets anyone report the item as found, with a free-text note and an optional contact detail. |
| FR-PUB-03 | Must | Found reports appear to the Quartermaster in the app as actionable items. |
| FR-PUB-04 | Should | Per-item toggle to allow raising a repair ticket from the public page. |
| FR-PUB-05 | Should | Public submissions are rate-limited and protected against spam. |
| FR-PUB-06 | Won't | Public check-in and check-out. We do not want gear movement recorded by unidentified people. |

## 8. Users, roles, and access (USR)

| ID | Priority | Requirement |
|---|---|---|
| FR-USR-01 | Must | Users sign in with an account tied to an email address. |
| FR-USR-02 | Must | Four roles: **Owner** (everything, including billing and hosting), **Admin** (everything except owner-only settings; manages users), **User** (add and edit items, check in and out, reserve, raise tickets; cannot change categories, locations, or users), **Read-only** (check in and out, raise tickets; cannot add, edit, or delete items or reservations). |
| FR-USR-03 | Must | Admins can invite, deactivate, and change the role of users. |
| FR-USR-04 | Must | An audit log records who changed what and when, for item edits, check-outs, check-ins, and role changes. |
| FR-USR-05 | Should | Sessions stay signed in on a trusted device for weeks. Nobody wants to type a password in a cold shed. |
| FR-USR-06 | Should | A shared "shed device" mode: the device is signed in, and the person acting picks their name from a short list before a batch. Faster than per-user login on a shared iPad. |
| FR-USR-07 | Could | Sign in with Google, to avoid managing passwords. |

## 9. Reports and data (RPT)

| ID | Priority | Requirement |
|---|---|---|
| FR-RPT-01 | Must | "What is out and who has it" — a single report. This is the group's biggest current pain point. |
| FR-RPT-02 | Must | Export the full inventory to CSV. No lock-in; this is also our backup of record. |
| FR-RPT-03 | Must | Export any filtered list to CSV. |
| FR-RPT-04 | Should | Overdue report: gear out past its expected return date. |
| FR-RPT-05 | Should | Repair report: open tickets, and repair history over a date range. |
| FR-RPT-06 | Should | Valuation report: total purchase value by category and location, for insurance. |
| FR-RPT-07 | Could | Usage report: which gear moves and which has not left the shed in a year. |
| FR-RPT-08 | Could | Printable pick list for a reservation, to work from on paper as a fallback. |

## 10. Offline and sync (OFF)

Requirements that apply if we adopt the offline or hybrid deployment model.
See [NFR-DEP](non-functional-requirements.md#7-deployment-model-dep).

| ID | Priority | Requirement |
|---|---|---|
| FR-OFF-01 | Must | Check-out, check-in, and search work with no network connection. These are the flows that happen in the shed. |
| FR-OFF-02 | Must | Work done offline is stored on the device and syncs when a connection returns, without the user doing anything. |
| FR-OFF-03 | Must | The user can see whether they are online, and whether anything is waiting to sync. |
| FR-OFF-04 | Must | Two devices acting on the same item offline must not lose data. Movements are recorded as an ordered event log per item, not as overwrites of a status field. |
| FR-OFF-05 | Should | Conflicts a machine cannot resolve are queued for the Quartermaster to settle, with both versions shown. |
| FR-OFF-06 | Should | Sync completes on a slow connection without a full re-download of the inventory. |
