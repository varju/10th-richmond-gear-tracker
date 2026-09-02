# Functional requirements

Priorities are Must, Should, Could, Won't.

---

## 1. Setup and configuration (SET)

| ID        | Priority | Requirement                                                                                                                                                                                                                                                                        |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-SET-01 | Must     | Holds the inventory for one Scout group. The group name appears on labels and printed reports.                                                                                                                                                                                     |
| FR-SET-02 | Must     | The Quartermaster can define **storage locations** and reassign items between them. Today these are Cold locker, Warm locker, and Garry Point yard.                                                                                                                                |
| FR-SET-03 | Must     | An item's home has an optional free-form sub-location label, e.g. "shelf 4" or "trailer 2". No fixed list, no hierarchy, no referential integrity. It is a label, not an entity.                                                                                                   |
| FR-SET-04 | Must     | A sub-location label cannot be renamed in one place, because it is not stored in one place. Changing several items means editing those items.                                                                                                                                      |
| FR-SET-05 | Must     | Deleting a location still in use is blocked. The message names the items blocking it. The same rule applies to categories (FR-SET-07) and types (FR-SET-10).                                                                                                                       |
| FR-SET-10 | Should   | The Quartermaster can define **types**, e.g. "4-person tent, Brand X" or "2-burner propane stove", and assign items to them. Items of one type are interchangeable for reservations (FR-RES-13). Nothing else is shared: repairs and history stay per item (FR-INV-06, FR-REP-01). |
| FR-SET-07 | Could    | The Quartermaster can define **categories** (tents, stoves, tarps, cooking gear) and reassign items between them.                                                                                                                                                                  |
| FR-SET-08 | Won't    | Withdrawn: import an initial inventory from CSV. Nothing to import; the first load is the labelling walk (FR-TAG-07).                                                                                                                                                              |
| FR-SET-09 | Won't    | Withdrawn: nested sub-locations. Free-form labels do not nest.                                                                                                                                                                                                                     |
| FR-SET-06 | Won't    | Withdrawn: a free-form condition field on an item. It said the same thing as a note (FR-OUT-13) or a repair ticket (FR-REP-01), and unlike either it carried no date and no author.                                                                                                |

## 2. Inventory (INV)

| ID        | Priority | Requirement                                                                                                                                                                                                                |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-INV-01 | Must     | Create, view, edit, and retire a gear item. Required fields: name, home location, home sub-location, notes. Category (FR-SET-07) appears when it is built.                                                                 |
| FR-INV-02 | Must     | **Home** is where an item belongs when not out, e.g. "Warm locker / shelf 4". Distinct from where it is right now.                                                                                                         |
| FR-INV-03 | Must     | Every item records **date added** and **date modified**. Set by the system, not editable. Modified means a change to the item's own fields, not a check-out or a repair.                                                   |
| FR-INV-04 | Must     | Retire an item rather than delete it, so history survives. Retired items are hidden by default and cannot be checked out.                                                                                                  |
| FR-INV-05 | Must     | Show retired items on demand, and unretire one. An unretired item keeps its original code (FR-TAG-01).                                                                                                                     |
| FR-INV-06 | Must     | Every item is a **tracked asset**: one thing, one label, checked out individually.                                                                                                                                         |
| FR-INV-07 | Must     | Search by name. Results appear as the user types, on 500 items.                                                                                                                                                            |
| FR-INV-08 | Must     | Filter the list by location, sub-location, type, and status (in, out, reserved, in repair, missing). Category joins the filters when it is built.                                                                          |
| FR-INV-09 | Must     | The item page shows status and holder, home, access history, repair history, and upcoming reservations.                                                                                                                    |
| FR-INV-10 | Should   | Browse by location then sub-location, to answer "what belongs on shelf 4?".                                                                                                                                                |
| FR-INV-11 | Should   | Attach photos to an item. Photos are never held in the offline copy. A photo taken with no signal is queued on the device and uploaded at the next sync; viewing one always needs a connection.                            |
| FR-INV-12 | Should   | Record purchase date, price, and supplier.                                                                                                                                                                                 |
| FR-INV-19 | Should   | Mark an item **missing**. It stays in the inventory, is excluded from what-is-out (FR-RPT-01), and clears on the next scan or check-in. Retire (FR-INV-04) is for gear written off; missing is for gear that is only lost. |
| FR-INV-20 | Should   | Leaving a screen with unsaved edits asks whether to save, discard, or keep editing.                                                                                                                                        |
| FR-INV-14 | Could    | A second kind, **consumables**: a stock count, e.g. fuel canisters, drawn down rather than checked out.                                                                                                                    |
| FR-INV-15 | Could    | Consumable stock decrements on issue and can be adjusted manually with a reason.                                                                                                                                           |
| FR-INV-16 | Could    | Group items into **kits** ("Patrol box 3": stove, 2 pots, lighter) and check the kit out in one action.                                                                                                                    |
| FR-INV-17 | Could    | Low-stock alert on consumables when the count drops below a per-item threshold.                                                                                                                                            |
| FR-INV-18 | Could    | Bulk edit: change category or home on several items at once.                                                                                                                                                               |
| FR-INV-13 | Could    | Merge duplicate items. Both histories move to the survivor. A Could because an append-only per-item log (NFR-DATA-02) makes a merge a rewrite, and the design for that is not settled.                                     |

## 3. Labels and QR codes (TAG)

Codes are code-first, not item-first. We print sheets of unassigned codes, stick them on gear, and bind each one to an
item by scanning it. A code is never generated for a specific item.

| ID        | Priority | Requirement                                                                                                                                                            |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-TAG-01 | Must     | Every tracked asset has a unique ID in a QR code. The item's identity is permanent; its current code is not (FR-TAG-04).                                               |
| FR-TAG-02 | Must     | Generate a PDF sheet of new **unassigned** codes, laid out for Avery 6576 (1.75" x 1.25"). One hardcoded layout; not configurable.                                     |
| FR-TAG-03 | Must     | Labels carry the QR code and the group name. Nothing else.                                                                                                             |
| FR-TAG-04 | Must     | Assign a new code to an item whose sticker was lost or damaged, by binding an unassigned code to it. The item keeps its identity and history.                          |
| FR-TAG-05 | Must     | Replaced codes still resolve to their item, and are never reused. A sticker found later must not point at the wrong gear.                                              |
| FR-TAG-06 | Must     | Scanning an **assigned** code opens its item.                                                                                                                          |
| FR-TAG-07 | Must     | Scanning an **unassigned** code offers two choices: create a new item, or bind the code to an existing item.                                                           |
| FR-TAG-13 | Must     | A code's QR contains a full URL on a domain the group owns, not the server's address. Stickers are printed once and must survive the server moving house (NFR-DEP-09). |
| FR-TAG-08 | Won't    | Withdrawn: print a label for one item. All codes come from pre-printed sheets (FR-TAG-02).                                                                             |
| FR-TAG-09 | Won't    | Withdrawn: merged into FR-TAG-03. Labels carry nothing but the QR code and the group name.                                                                             |
| FR-TAG-10 | Won't    | Reprint a label using the same ID. Cheaper to take a code off a pre-printed sheet and rebind it (FR-TAG-04).                                                           |
| FR-TAG-11 | Won't    | Withdrawn: merged into FR-TAG-02. Every printed code starts unassigned, so this is no longer a separate feature.                                                       |
| FR-TAG-12 | Won't    | Withdrawn: merged into FR-TAG-07.                                                                                                                                      |

## 4. Check-out and check-in (OUT)

The core workflow. It happens in an unheated locker or an outdoor yard, on a phone, in gloves.

| ID        | Priority | Requirement                                                                                                                                                                                                     |
| --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-OUT-01 | Must     | Check out an item by scanning its label.                                                                                                                                                                        |
| FR-OUT-02 | Must     | Check out an item found by search or browse, no scan. Not all gear is labelled.                                                                                                                                 |
| FR-OUT-03 | Must     | One scan, one tap. The scan shows the item so the user can check it against what is in their hand, and a single button confirms the move. The scanner is then ready for the next item.                          |
| FR-OUT-04 | Must     | Check-out records who, when, and optionally which event.                                                                                                                                                        |
| FR-OUT-05 | Must     | Set the event once at the start of a scanning session. It applies to every item scanned until the user changes it, clears it, or ends the session. The session is a setting on one device, not a shared record. |
| FR-OUT-06 | Must     | Scanning is contextual. A signed-in user who scans an item that is **out** checks it in, and gets the check-in workflow (FR-OUT-09, FR-OUT-10). Scanning an item that is **in** starts a check-out.             |
| FR-OUT-07 | Must     | Check an item in from search or browse, no scan. Mirrors FR-OUT-02 for unlabelled gear.                                                                                                                         |
| FR-OUT-08 | Must     | Anyone can check in gear someone else took out.                                                                                                                                                                 |
| FR-OUT-09 | Must     | Raise a repair ticket from the check-in screen ("zipper broken on tent bag"), without leaving the flow.                                                                                                         |
| FR-OUT-10 | Must     | Check-in shows the item's home prominently, so the Scouter knows where to put it.                                                                                                                               |
| FR-OUT-11 | Must     | Edit the item from the check-in screen: home, notes, any field.                                                                                                                                                 |
| FR-OUT-12 | Must     | Checking out gear that is already out shows who has it and offers to transfer. Reached by search, or by overriding the contextual default (FR-OUT-06).                                                          |
| FR-OUT-13 | Should   | Within a session, add a per-item note without changing the event, e.g. "handed to a patrol leader" (FR-OUT-15).                                                                                                 |
| FR-OUT-14 | Should   | Flag gear that has been out longer than a group-wide period, e.g. 30 days. One setting, no per-item dates.                                                                                                      |
| FR-OUT-15 | Should   | Every movement event carries an optional free-form note, e.g. "taken by a parent for the weekend". Covers holders who are not system users.                                                                     |
| FR-OUT-16 | Should   | A note can be edited later. The edit appends a correction to the log; the original event is never rewritten (NFR-DATA-02). The item page shows the current text.                                                |
| FR-OUT-21 | Should   | A note can be deleted. Like an edit, deletion appends to the log rather than rewriting it (NFR-DATA-02): the note stops being shown, and who wrote it and when stays in the audit.                              |
| FR-OUT-17 | Won't    | Withdrawn: no batch check-in. FR-OUT-10 shows the home at the scan, while the Scouter is holding the item.                                                                                                      |
| FR-OUT-18 | Won't    | Withdrawn: merged into FR-OUT-11. Changing the home is just an edit.                                                                                                                                            |
| FR-OUT-19 | Won't    | Withdrawn: set an expected return date at check-out. Too much work for a Scouter in a locker, so it would not get filled in.                                                                                    |
| FR-OUT-20 | Won't    | Withdrawn: recording the state gear came back in as its own step. It is an edit or a note, so FR-OUT-11 covers it.                                                                                              |

## 5. Reservations (RES)

| ID        | Priority | Requirement                                                                                                                                                                                                                                                                        |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-RES-01 | Must     | Create a reservation with an event name, a date range, and a list of items.                                                                                                                                                                                                        |
| FR-RES-02 | Must     | Checking out a reservation starts a scanning session seeded with its item list. Each scan ticks one off, and the screen always shows what is still unscanned. Unlabelled items are ticked off from the list itself (FR-OUT-02); nothing else is checked out without being scanned. |
| FR-RES-03 | Must     | The session's event name comes from the reservation (FR-OUT-05). The user does not type it again.                                                                                                                                                                                  |
| FR-RES-04 | Must     | Finishing a session with items unscanned warns and names them. The user can finish anyway.                                                                                                                                                                                         |
| FR-RES-05 | Should   | Block a conflicting reservation. The message names the conflicting event.                                                                                                                                                                                                          |
| FR-RES-06 | Should   | The unscanned list is ordered by home.                                                                                                                                                                                                                                             |
| FR-RES-07 | Should   | Scanning an item that is not on the reservation appends it to the check-out. No warning, no special handling.                                                                                                                                                                      |
| FR-RES-08 | Should   | Warn, but allow, when a reserved item has an open repair ticket.                                                                                                                                                                                                                   |
| FR-RES-09 | Should   | Warn when checking out an item someone else reserved for an overlapping date.                                                                                                                                                                                                      |
| FR-RES-10 | Should   | Duplicate a reservation, carrying the gear list over.                                                                                                                                                                                                                              |
| FR-RES-13 | Should   | Reserve a quantity of a type ("4 × 4-person tent, Brand X") instead of naming items (FR-SET-10). At check-out, scanning any item of that type ticks one off (FR-RES-02).                                                                                                           |
| FR-RES-15 | Should   | A reservation by type conflicts (FR-RES-05) when the quantity reserved across overlapping dates exceeds the number of unretired items of that type.                                                                                                                                |
| FR-RES-11 | Could    | Reserve a quantity of a consumable, not just tracked assets.                                                                                                                                                                                                                       |
| FR-RES-12 | Could    | Calendar view of reservations alongside the list view.                                                                                                                                                                                                                             |
| FR-RES-14 | Won't    | Withdrawn: no return session. Returns use the standard check-in (FR-OUT-06). Anyone can return gear, piecemeal, with no reference to the reservation.                                                                                                                              |

## 6. Repairs and maintenance (REP)

| ID        | Priority | Requirement                                                                                                                               |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| FR-REP-01 | Must     | Raise a repair ticket against an item, with a description and an optional photo. The photo follows the same online-only rule (FR-INV-11). |
| FR-REP-02 | Must     | Any signed-in user can raise a ticket.                                                                                                    |
| FR-REP-03 | Must     | A ticket moves through states: open, in progress, resolved, won't fix.                                                                    |
| FR-REP-04 | Must     | Ticket history stays on the item after the ticket closes.                                                                                 |
| FR-REP-05 | Must     | Items with an open ticket are flagged in lists and at check-out.                                                                          |
| FR-REP-06 | Must     | A ticket carries free-form comments, added and edited over the life of the repair. Cost, time, and parts go here if anyone records them.  |
| FR-REP-07 | Could    | Assign a ticket to a person.                                                                                                              |
| FR-REP-08 | Could    | Scheduled maintenance reminders: air tents each spring, service stoves annually.                                                          |
| FR-REP-09 | Won't    | Withdrawn: structured cost, time, and parts fields. Too much structure for a volunteer repair log. Use a comment (FR-REP-06).             |

## 7. Public pages (PUB)

Reachable by scanning a label, with no sign-in.

| ID        | Priority | Requirement                                                                                                                                                   |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-PUB-01 | Must     | Scanning while signed out shows the item name, the group name, and how to reach us. No member names, prices, or history.                                      |
| FR-PUB-02 | Must     | Anyone can report the item found, with a note and optional contact detail.                                                                                    |
| FR-PUB-03 | Must     | Found reports reach the Quartermaster in the app, as something to act on.                                                                                     |
| FR-PUB-04 | Should   | Public submissions are rate-limited and spam-protected.                                                                                                       |
| FR-PUB-05 | Won't    | Withdrawn: raise a repair ticket from the public page. Members raise tickets when signed in (FR-REP-02); the public route is for found gear only (FR-PUB-02). |
| FR-PUB-06 | Won't    | Public check-in and check-out. We will not record gear movement by unidentified people.                                                                       |

## 8. Users, roles, and access (USR)

| ID        | Priority | Requirement                                                                                                                                                                                                                                     |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-USR-01 | Must     | Users sign in with an account tied to an email address.                                                                                                                                                                                         |
| FR-USR-02 | Must     | Two roles: **Admin** (everything, including managing users and settings) and **User** (everything operational: add and edit items, check in and out, reserve, raise tickets).                                                                   |
| FR-USR-03 | Must     | The last Admin cannot be demoted or deactivated.                                                                                                                                                                                                |
| FR-USR-04 | Must     | Admins can invite, deactivate, and change the role of users.                                                                                                                                                                                    |
| FR-USR-05 | Must     | An audit log records who changed what, and when: item edits, check-outs, check-ins, and every change to users — invited, deactivated, reactivated, role changed. Edits store the field, its old value, and its new value, not a whole snapshot. |
| FR-USR-06 | Must     | Deactivating a user does not remove them from the audit log.                                                                                                                                                                                    |
| FR-USR-07 | Must     | Sessions never expire. A signed-in device stays signed in until the user signs out or an Admin deactivates the account.                                                                                                                         |
| FR-USR-08 | Must     | Sign-in is exchanged once for a long-lived local session (FR-USR-07). The app never needs to reach an identity provider at the lockers.                                                                                                         |
| FR-USR-12 | Must     | Invites and password resets are one-time links. An Admin generates a link and passes it on by whatever channel the group already uses. A link is always shown, whether or not the server can mail it (FR-USR-15).                               |
| FR-USR-13 | Must     | The first Admin account is created from the command line when the server is installed. There is no open sign-up.                                                                                                                                |
| FR-USR-09 | Should   | The Quartermaster can read an item's audit history from its detail page.                                                                                                                                                                        |
| FR-USR-14 | Should   | An Admin can revoke one device without deactivating its account, for a phone that was lost or sold.                                                                                                                                             |
| FR-USR-15 | Should   | The server mails invite and reset links itself, from one SMTP account an Admin fills in. Optional: a group that sets none up pays for no mail service (NFR-DEP-04).                                                                             |
| FR-USR-16 | Should   | An Admin can send a test message to their own address, to find a wrong mail password before someone else's reset needs it.                                                                                                                      |
| FR-USR-10 | Could    | Sign in with Google, to avoid managing passwords (NFR-SEC-02).                                                                                                                                                                                  |
| FR-USR-11 | Won't    | Withdrawn: shared-device mode. Personal phones only.                                                                                                                                                                                            |

## 9. Reports and data (RPT)

| ID        | Priority | Requirement                                                                 |
| --------- | -------- | --------------------------------------------------------------------------- |
| FR-RPT-01 | Must     | One report: what is out, and who has it.                                    |
| FR-RPT-02 | Should   | Repair report: open tickets, and repair history over a date range.          |
| FR-RPT-03 | Could    | Export the full inventory to CSV. Not the backup of record; NFR-DATA-06 is. |
| FR-RPT-04 | Could    | Export any filtered list to CSV.                                            |
| FR-RPT-05 | Could    | Overdue report: gear out longer than the group-wide period (FR-OUT-14).     |
| FR-RPT-06 | Could    | Valuation: total purchase value by category and location.                   |
| FR-RPT-07 | Could    | Usage: which gear moves, and which has not left the locker in a year.       |
| FR-RPT-08 | Could    | Printable pick list for a reservation, grouped by home.                     |
| FR-RPT-09 | Could    | Misplaced gear: items in, but not at their home.                            |
| FR-RPT-10 | Could    | Printable contents sheet per sub-location, listing what belongs there.      |

## 10. Offline and sync (OFF)

Applies if we adopt the offline model. See [NFR-DEP](non-functional-requirements.md#1-deployment-model-dep).

Two iOS facts shape this whole section. Safari does not support the Background Sync API and is not expected to, so a
closed app on a locked iPhone will not sync. Safari also clears a browser tab's storage after 7 days without a visit,
which would take unsent work with it. So: sync happens while the app is open, the app is installed to the home screen to
escape eviction (NFR-DEP-06), and pending work is visible enough that nobody walks away unaware.

| ID        | Priority | Requirement                                                                                                                                                                                                                |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-OFF-01 | Must     | Check-out, check-in, and search work with no network.                                                                                                                                                                      |
| FR-OFF-02 | Must     | Offline work is stored on device and uploads whenever the app is open and a connection is available. There is no sync button to press.                                                                                     |
| FR-OFF-03 | Must     | Every record is sent as soon as it is made; records collect on the device only while a sync fails. Sync is also attempted on every app open and on regaining connectivity. Opening the app is the reliable trigger on iOS. |
| FR-OFF-04 | Must     | Whenever anything is unsent, a persistent banner shows the count on every screen. It stays until the records are sent.                                                                                                     |
| FR-OFF-05 | Must     | Two devices acting offline on one item lose nothing. Movements are an ordered event log per item, not status overwrites.                                                                                                   |
| FR-OFF-06 | Must     | A deactivated account can still push its pending records one last time. Accept the work, attribute it to them in the audit log, then refuse everything else from that credential.                                          |
| FR-OFF-07 | Must     | Revocation never discards data (NFR-DATA-01).                                                                                                                                                                              |
| FR-OFF-14 | Must     | A new or reset device is set up from a current-state snapshot, not by replaying the whole log. Retention (NFR-DATA-03) trims history on the device, never the state derived from it.                                       |
| FR-OFF-08 | Should   | Use Background Sync where the platform supports it, e.g. Chrome on Android. Treat it as a bonus. Never design as though it will run.                                                                                       |
| FR-OFF-09 | Should   | Records pending more than 3 days interrupt on app open, rather than sitting in the banner (FR-OFF-04).                                                                                                                     |
| FR-OFF-10 | Should   | Conflicts a machine cannot resolve queue for the Quartermaster, showing both versions. The trigger is defined, not guessed: two check-outs of one item from different devices with no check-in between them.               |
| FR-OFF-11 | Should   | Sync on a slow connection without re-downloading the whole inventory.                                                                                                                                                      |
| FR-OFF-12 | Could    | The server pushes a reminder when a device has movements it has not seen, using web push. Needs the server to infer a device is behind.                                                                                    |
| FR-OFF-13 | Won't    | Withdrawn: warn at the end of a session. Ad-hoc scanning has no end; people just stop. FR-OFF-04 carries the warning continuously instead.                                                                                 |
