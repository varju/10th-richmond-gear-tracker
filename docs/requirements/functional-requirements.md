# Functional requirements

Priorities are Must, Should, Could, Won't.

---

## 1. Setup and configuration (SET)

| ID         | Priority | Requirement                                                                                                                                                                      |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-SET-01  | Must     | Holds the inventory for one Scout group. The group name appears on labels and printed reports.                                                                                   |
| FR-SET-02  | Could    | The Quartermaster can define **categories** (tents, stoves, tarps, cooking gear) and reassign items between them.                                                                |
| FR-SET-03  | Must     | The Quartermaster can define **storage locations** and reassign items between them. Today these are Cold locker, Warm locker, and Garry Point yard.                              |
| FR-SET-03a | Must     | An item's home has an optional free-form sub-location label, e.g. "shelf 4" or "trailer 2". No fixed list, no hierarchy, no referential integrity. It is a label, not an entity. |
| FR-SET-03b | Must     | Changing a sub-location label across several items at once is a bulk edit (FR-INV-13), not a rename of anything.                                                                 |
| FR-SET-04  | Must     | Deleting a category or location still in use is blocked. The message names the items blocking it.                                                                                |
| FR-SET-05  | Should   | Condition is an optional free-form text field on an item. No fixed values.                                                                                                       |
| FR-SET-06  | Won't    | Withdrawn: import an initial inventory from CSV. Nothing to import; the first load is the labelling walk (FR-TAG-07).                                                            |
| FR-SET-07  | Won't    | Withdrawn: nested sub-locations. Free-form labels do not nest.                                                                                                                   |

## 2. Inventory (INV)

| ID         | Priority | Requirement                                                                                                                                                                                                                          |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-INV-01  | Must     | Create, view, edit, and retire a gear item. Fields: name, category, home location, home sub-location, condition, quantity, notes, tags.                                                                                              |
| FR-INV-01a | Must     | **Home** is where an item belongs when not out, e.g. "Warm locker / shelf 4". Distinct from where it is right now.                                                                                                                   |
| FR-INV-01b | Must     | Every item records **date added** and **date modified**. Set by the system, not editable. Modified means a change to the item's own fields, not a check-out or a repair.                                                             |
| FR-INV-02  | Must     | Retire an item rather than delete it, so history survives. Retired items are hidden by default and cannot be checked out.                                                                                                            |
| FR-INV-02a | Must     | Show retired items on demand, and unretire one. An unretired item keeps its original code (FR-TAG-01).                                                                                                                               |
| FR-INV-03  | Must     | Every item is a **tracked asset**: one thing, one label, checked out individually.                                                                                                                                                   |
| FR-INV-03a | Could    | A second kind, **consumables**: a stock count, e.g. fuel canisters, drawn down rather than checked out.                                                                                                                              |
| FR-INV-04  | Could    | Consumable stock decrements on issue and can be adjusted manually with a reason.                                                                                                                                                     |
| FR-INV-05  | Must     | Search by name. Results appear as the user types, on 500 items.                                                                                                                                                                      |
| FR-INV-06  | Must     | Filter the list by category, location, sub-location, condition, and status (in, out, reserved, in repair).                                                                                                                           |
| FR-INV-06a | Should   | Browse by location then sub-location, to answer "what belongs on shelf 4?". This is the shape of a stock check.                                                                                                                      |
| FR-INV-07  | Must     | The item page shows status and holder, home, access history, repair history, and upcoming reservations.                                                                                                                              |
| FR-INV-08  | Should   | Attach photos to an item. Photos live on the server only, never in the offline copy. Viewing and adding both need a connection, so damage cannot be photographed at the locker; it is added later or described in words (FR-REP-06). |
| FR-INV-09  | Should   | Record purchase date, price, and supplier, for insurance and replacement planning.                                                                                                                                                   |
| FR-INV-10  | Should   | Merge duplicate items. Both histories move to the survivor.                                                                                                                                                                          |
| FR-INV-11  | Could    | Group items into **kits** ("Patrol box 3": stove, 2 pots, lighter) and check the kit out in one action.                                                                                                                              |
| FR-INV-12  | Could    | Low-stock alert on consumables when the count drops below a per-item threshold.                                                                                                                                                      |
| FR-INV-13  | Could    | Bulk edit: change category, home, or condition on several items at once.                                                                                                                                                             |

## 3. Labels and QR codes (TAG)

Codes are code-first, not item-first. We print sheets of unassigned codes, stick them on gear, and bind each one to an
item by scanning it. A code is never generated for a specific item.

| ID         | Priority | Requirement                                                                                                                                   |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-TAG-01  | Must     | Every tracked asset has a unique ID in a QR code. The item's identity is permanent; its current code is not (FR-TAG-05a).                     |
| FR-TAG-02  | Won't    | Withdrawn: print a label for one item. All codes come from pre-printed sheets (FR-TAG-03).                                                    |
| FR-TAG-03  | Must     | Generate a PDF sheet of new **unassigned** codes, laid out for Avery 6576 (1.75" x 1.25"). One hardcoded layout; not configurable.            |
| FR-TAG-04  | Must     | Labels carry the QR code and the group name. Nothing else.                                                                                    |
| FR-TAG-04a | Won't    | Withdrawn: merged into FR-TAG-04. Labels carry nothing but the QR code and the group name.                                                    |
| FR-TAG-05  | Won't    | Reprint a label using the same ID. Cheaper to take a code off a pre-printed sheet and rebind it (FR-TAG-05a).                                 |
| FR-TAG-05a | Must     | Assign a new code to an item whose sticker was lost or damaged, by binding an unassigned code to it. The item keeps its identity and history. |
| FR-TAG-05b | Must     | Replaced codes still resolve to their item, and are never reused. A sticker found later must not point at the wrong gear.                     |
| FR-TAG-06  | Must     | Scanning an **assigned** code opens its item.                                                                                                 |
| FR-TAG-07  | Must     | Scanning an **unassigned** code offers two choices: create a new item, or bind the code to an existing item.                                  |
| FR-TAG-08  | Won't    | Withdrawn: merged into FR-TAG-03. Every printed code starts unassigned, so this is no longer a separate feature.                              |
| FR-TAG-09  | Won't    | Withdrawn: merged into FR-TAG-07.                                                                                                             |

## 4. Check-out and check-in (OUT)

The core workflow. It happens in an unheated locker or an outdoor yard, on a phone, in gloves.

| ID         | Priority | Requirement                                                                                                                                                                                          |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-OUT-01  | Must     | Check out an item by scanning its label.                                                                                                                                                             |
| FR-OUT-02  | Must     | Check out an item found by search or browse, no scan. Not all gear is labelled.                                                                                                                      |
| FR-OUT-03  | Must     | One scan, one tap. The scan shows the item so the user can check it against what is in their hand, and a single button confirms the move. The scanner is then ready for the next item.               |
| FR-OUT-04  | Must     | Check-out records who, when, and optionally which event.                                                                                                                                             |
| FR-OUT-04a | Must     | Set the event once at the start of a scanning session. It applies to every item checked out until the user changes or clears it.                                                                     |
| FR-OUT-04b | Should   | Within a session, add a per-item note without changing the event, e.g. "handed to Sam". Event is for the trip; note is for the item (FR-OUT-12).                                                     |
| FR-OUT-05  | Must     | Scanning is contextual. A signed-in user who scans an item that is **out** checks it in, and gets the check-in workflow (FR-OUT-07, FR-OUT-07a). Scanning an item that is **in** starts a check-out. |
| FR-OUT-05a | Must     | Check an item in from search or browse, no scan. Mirrors FR-OUT-02 for unlabelled gear.                                                                                                              |
| FR-OUT-06  | Must     | Anyone can check in gear someone else took out.                                                                                                                                                      |
| FR-OUT-07  | Must     | Raise a repair ticket from the check-in screen ("zipper broken on tent bag"), without leaving the flow.                                                                                              |
| FR-OUT-07a | Must     | Check-in shows the item's home prominently, so the Scouter knows where to put it. This is the point of sub-locations.                                                                                |
| FR-OUT-07b | Won't    | Withdrawn: no batch check-in, so there is no end-of-batch moment. FR-OUT-07a shows the home at the scan, while the Scouter is holding the item.                                                      |
| FR-OUT-07c | Won't    | Withdrawn: merged into FR-OUT-07d. Changing the home is just an edit.                                                                                                                                |
| FR-OUT-07d | Must     | Edit the item from the check-in screen: condition, home, notes, any field. No need to leave the flow and find it again.                                                                              |
| FR-OUT-08  | Must     | Checking out gear that is already out shows who has it and offers to transfer. Reached by search, or by overriding the contextual default (FR-OUT-05).                                               |
| FR-OUT-09  | Won't    | Withdrawn: set an expected return date at check-out. Too much work for a Scouter in a locker, so it would not get filled in.                                                                         |
| FR-OUT-10  | Should   | Flag gear that has been out longer than a group-wide period, e.g. 30 days. One setting, no per-item dates.                                                                                           |
| FR-OUT-11  | Won't    | Withdrawn: merged into FR-OUT-07d. Changing the condition is just an edit.                                                                                                                           |
| FR-OUT-12  | Should   | Every movement event carries an optional free-form note, e.g. "taken by a parent for the weekend". This covers holders who are not system users, without modelling them.                             |
| FR-OUT-12a | Should   | A note can be edited later. The edit appends a correction to the log; the original event is never rewritten (NFR-DATA-02). The item page shows the current text.                                     |

## 5. Reservations (RES)

| ID         | Priority | Requirement                                                                                                                                                                                             |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-RES-01  | Must     | Create a reservation with an event name, a date range, and a list of items.                                                                                                                             |
| FR-RES-02  | Should   | Block a conflicting reservation. The message names the conflicting event.                                                                                                                               |
| FR-RES-03  | Must     | Checking out a reservation starts a scanning session seeded with its item list. Each scan ticks one off. The screen always shows what is still unscanned. Nothing is checked out without being scanned. |
| FR-RES-03a | Must     | The session's event name comes from the reservation (FR-OUT-04a). The user does not type it again.                                                                                                      |
| FR-RES-03b | Must     | Finishing a session with items unscanned warns and names them. The user can finish anyway; leaving gear behind on purpose is normal.                                                                    |
| FR-RES-03c | Should   | The unscanned list is ordered by home, so working down it is one walk of the lockers.                                                                                                                   |
| FR-RES-03d | Should   | Scanning an item that is not on the reservation appends it to the check-out. No warning, no special handling.                                                                                           |
| FR-RES-03e | Won't    | Withdrawn: no return session. Returns use the standard check-in (FR-OUT-05). Anyone can return gear, piecemeal, with no reference to the reservation.                                                   |
| FR-RES-04  | Should   | Warn, but allow, when a reserved item has an open repair ticket.                                                                                                                                        |
| FR-RES-05  | Should   | Warn when checking out an item someone else reserved for an overlapping date.                                                                                                                           |
| FR-RES-06  | Should   | Duplicate a reservation, carrying the gear list over. Camps repeat annually.                                                                                                                            |
| FR-RES-07  | Could    | Reserve a quantity of a consumable, not just tracked assets.                                                                                                                                            |
| FR-RES-08  | Could    | Calendar view of reservations alongside the list view.                                                                                                                                                  |
| FR-RES-09  | Could    | Reserve a category ("4 tents"), resolved to specific items at check-out.                                                                                                                                |

## 6. Repairs and maintenance (REP)

| ID        | Priority | Requirement                                                                                                                                              |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-REP-01 | Must     | Raise a repair ticket against an item, with a description and an optional photo. The photo follows the same online-only rule (FR-INV-08).                |
| FR-REP-02 | Must     | Any signed-in user can raise a ticket.                                                                                                                   |
| FR-REP-03 | Must     | A ticket moves through states: open, in progress, resolved, won't fix.                                                                                   |
| FR-REP-04 | Must     | Ticket history stays on the item after the ticket closes.                                                                                                |
| FR-REP-05 | Must     | Items with an open ticket are flagged in lists and at check-out.                                                                                         |
| FR-REP-06 | Must     | A ticket carries free-form comments, added and edited over the life of the repair. This is where cost, time, or parts go if anyone cares to record them. |
| FR-REP-07 | Could    | Assign a ticket to a person.                                                                                                                             |
| FR-REP-08 | Won't    | Withdrawn: structured cost, time, and parts fields. Too much structure for a volunteer repair log. Use a comment (FR-REP-06).                            |
| FR-REP-09 | Could    | Scheduled maintenance reminders: air tents each spring, service stoves annually.                                                                         |

## 7. Public pages (PUB)

Reachable by scanning a label, with no sign-in.

| ID        | Priority | Requirement                                                                                                                                                   |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-PUB-01 | Must     | Scanning while signed out shows the item name, the group name, and how to reach us. No member names, prices, or history.                                      |
| FR-PUB-02 | Must     | Anyone can report the item found, with a note and optional contact detail.                                                                                    |
| FR-PUB-03 | Must     | Found reports reach the Quartermaster in the app, as something to act on.                                                                                     |
| FR-PUB-04 | Won't    | Withdrawn: raise a repair ticket from the public page. Members raise tickets when signed in (FR-REP-02); the public route is for found gear only (FR-PUB-02). |
| FR-PUB-05 | Should   | Public submissions are rate-limited and spam-protected.                                                                                                       |
| FR-PUB-06 | Won't    | Public check-in and check-out. We will not record gear movement by unidentified people.                                                                       |

## 8. Users, roles, and access (USR)

| ID         | Priority | Requirement                                                                                                                                                                                                                                     |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-USR-01  | Must     | Users sign in with an account tied to an email address.                                                                                                                                                                                         |
| FR-USR-02  | Must     | Two roles: **Admin** (everything, including managing users and settings) and **User** (everything operational: add and edit items, check in and out, reserve, raise tickets).                                                                   |
| FR-USR-02a | Must     | The last Admin cannot be demoted or deactivated. Otherwise the group can lock itself out of its own inventory.                                                                                                                                  |
| FR-USR-03  | Must     | Admins can invite, deactivate, and change the role of users.                                                                                                                                                                                    |
| FR-USR-04  | Must     | An audit log records who changed what, and when: item edits, check-outs, check-ins, and every change to users — invited, deactivated, reactivated, role changed. Edits store the field, its old value, and its new value, not a whole snapshot. |
| FR-USR-04a | Should   | The Quartermaster can read an item's audit history from its detail page. Capture is the Must (NFR-DATA-02b); the viewer can follow.                                                                                                             |
| FR-USR-04b | Must     | Deactivating a user does not remove them from the audit log. History stays attributable, or it is not an audit log.                                                                                                                             |
| FR-USR-05  | Must     | Sessions never expire. A signed-in device stays signed in until the user signs out or an Admin deactivates the account. Nobody types a password in a cold locker.                                                                               |
| FR-USR-06  | Won't    | Withdrawn: shared-device mode. Personal phones only. No identity switching to build.                                                                                                                                                            |
| FR-USR-07  | Could    | Sign in with Google, to avoid managing passwords and the duty of care that comes with them (NFR-SEC-02).                                                                                                                                        |
| FR-USR-07a | Must     | Whatever the sign-in method, it is exchanged once for a long-lived local session (FR-USR-05). The app never needs to reach an identity provider at the lockers.                                                                                 |

## 9. Reports and data (RPT)

| ID        | Priority | Requirement                                                                                                               |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| FR-RPT-01 | Must     | One report: what is out, and who has it. The group's biggest pain point today.                                            |
| FR-RPT-02 | Could    | Export the full inventory to CSV. Useful for spreadsheets and for leaving, but not the backup of record: NFR-DATA-03a is. |
| FR-RPT-03 | Could    | Export any filtered list to CSV.                                                                                          |
| FR-RPT-04 | Could    | Overdue report: gear out longer than the group-wide period (FR-OUT-10).                                                   |
| FR-RPT-05 | Should   | Repair report: open tickets, and repair history over a date range.                                                        |
| FR-RPT-06 | Could    | Valuation: total purchase value by category and location, for insurance.                                                  |
| FR-RPT-07 | Could    | Usage: which gear moves, and which has not left the locker in a year.                                                     |
| FR-RPT-08 | Could    | Printable pick list for a reservation, grouped by home so one walk collects everything. Also a paper fallback.            |
| FR-RPT-09 | Could    | Misplaced gear: items in, but not at their home. Falls out of a stock check.                                              |
| FR-RPT-10 | Could    | Printable contents sheet per sub-location, listing what belongs there.                                                    |

## 10. Offline and sync (OFF)

Applies if we adopt the offline model. See [NFR-DEP](non-functional-requirements.md#1-deployment-model-dep).

iOS Safari does not support the Background Sync API and is not expected to. A closed app on a locked iPhone will not
sync. Everything below is written around that: sync happens while the app is open, and the pending state is made visible
enough that nobody walks away unaware.

| ID         | Priority | Requirement                                                                                                                                                                                                              |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-OFF-01  | Must     | Check-out, check-in, and search work with no network. These happen at the lockers.                                                                                                                                       |
| FR-OFF-02  | Must     | Offline work is stored on device and uploads whenever the app is open and a connection is available. It happens on its own; there is no sync button to press.                                                            |
| FR-OFF-02a | Must     | Sync is attempted on every app open, on regaining connectivity, and after every movement. Opening the app is the reliable trigger on iOS.                                                                                |
| FR-OFF-02b | Should   | Use Background Sync where the platform supports it, e.g. Chrome on Android. Treat it as a bonus. Never design as though it will run.                                                                                     |
| FR-OFF-03  | Must     | Whenever anything is unsent, a persistent banner shows the count on every screen. It stays until the records are sent. There is no end-of-session moment to hang a warning on, so the warning is always present instead. |
| FR-OFF-03a | Won't    | Withdrawn: warn at the end of a session. Ad-hoc scanning has no end; people just stop. FR-OFF-03 carries the warning continuously instead.                                                                               |
| FR-OFF-03b | Should   | Records pending longer than a few days are escalated on the device: harder to miss than a count.                                                                                                                         |
| FR-OFF-03c | Could    | The server pushes a reminder when a device has movements it has not seen, using web push. Needs the server to infer a device is behind, so treat as speculative.                                                         |
| FR-OFF-04  | Must     | Two devices acting offline on one item lose nothing. Movements are an ordered event log per item, not status overwrites.                                                                                                 |
| FR-OFF-05  | Should   | Conflicts a machine cannot resolve queue for the Quartermaster, showing both versions.                                                                                                                                   |
| FR-OFF-06  | Should   | Sync on a slow connection without re-downloading the whole inventory.                                                                                                                                                    |
| FR-OFF-07  | Must     | A deactivated account can still push its pending records one last time. Accept the work, attribute it to them in the audit log, then end the session.                                                                    |
| FR-OFF-08  | Must     | Revocation never discards data. Losing a week of real gear movements is worse than accepting a write from someone who has just left (NFR-DATA-01).                                                                       |
