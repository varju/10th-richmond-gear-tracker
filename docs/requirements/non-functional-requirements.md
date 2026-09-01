# Non-functional requirements

How well the system must work.

---

## 1. Deployment model (DEP)

Everything else hangs on this.

**A. Hosted service.** One server, used through a browser. Simple to build and operate. Dead at the lockers when the
signal drops.

**B. Offline-first client.** A progressive web app holding a full copy of the inventory on device. Works with no
network, syncs when one returns. The server is a sync point, not the source of truth during use.

**Recommendation: B, from the start.** Retrofitting offline onto a server-first design means reworking data access,
conflict handling, and most of the UI.

Personal phones only. A stationed tablet would not survive a winter in the Cold locker or the yard, and would sync less
often than a phone because it is opened less often. Design for the phones people carry.

| ID         | Priority | Requirement                                                                                                                           |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-DEP-01 | Must     | Runs in a mobile browser. No app store install, no per-device provisioning.                                                           |
| NFR-DEP-02 | Should   | Installs to a phone home screen and launches like an app.                                                                             |
| NFR-DEP-03 | Must     | Core flows (search, check-out, check-in) work with no network.                                                                        |
| NFR-DEP-04 | Must     | A single self-hosted server instance serves the whole group.                                                                          |
| NFR-DEP-05 | Should   | One volunteer can deploy it in under an hour from written instructions.                                                               |
| NFR-DEP-06 | Must     | Hosting costs nothing beyond the electricity of a box already running at home. Self-hosted at a volunteer's house.                    |
| NFR-DEP-08 | Must     | The server is reachable from the internet without exposing the host's home network. Prefer an outbound tunnel over forwarding a port. |
| NFR-DEP-07 | Could    | Runs on a small box on site with no internet at all, syncing when it gets a connection.                                               |

## 2. Usability (USE)

This competes with walking into a locker and taking a tent. Slower than that, and people take the tent.

| ID         | Priority | Requirement                                                                                                                                           |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-USE-01 | Must     | Under 5 seconds from scan to confirmed move, in either direction, once the scanner is open.                                                           |
| NFR-USE-02 | Must     | Ten items scan in one continuous session. One tap each, no other interaction unless the user chooses to edit.                                         |
| NFR-USE-03 | Must     | Usable one-handed on a phone, in the dark, with cold or gloved hands. Tap targets at least 44x44 px; primary actions in the lower half of the screen. |
| NFR-USE-04 | Must     | A new Scouter completes a check-out with no training.                                                                                                 |
| NFR-USE-05 | Must     | Works in current Safari on iOS and Chrome on Android. That is what volunteers carry.                                                                  |
| NFR-USE-06 | Should   | Readable outdoors in direct daylight and in an unlit locker: high contrast, minimum 16 px body text.                                                  |
| NFR-USE-07 | Won't    | Withdrawn: support an older stationed iPad. Personal phones only.                                                                                     |
| NFR-USE-08 | Should   | Every destructive action is undoable, or confirmed first.                                                                                             |
| NFR-USE-09 | Could    | Full keyboard operation with a bluetooth scanner, for bulk work at a desk.                                                                            |

## 3. Performance (PERF)

| ID           | Priority | Requirement                                                                                                                                                  |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NFR-PERF-01  | Must     | Search results appear within 200 ms of a keystroke on 500 items.                                                                                             |
| NFR-PERF-02  | Must     | Any list or detail page renders within 1 second on a 4-year-old mid-range phone.                                                                             |
| NFR-PERF-03  | Must     | The app starts within 3 seconds from the home screen icon, offline.                                                                                          |
| NFR-PERF-04  | Should   | The offline dataset for 500 items stays under 10 MB on device. Records only; photos are never cached (FR-INV-08).                                            |
| NFR-PERF-05  | Must     | A day's work (about 100 events, roughly 30 KB) uploads in under 5 seconds on a weak connection. The payload is tiny; the time goes to round trips, not size. |
| NFR-PERF-05a | Must     | Pending events upload in one batched request, not one per event. A hundred round trips is what would miss the target.                                        |
| NFR-PERF-05b | Must     | Sync never blocks the screen. The user keeps scanning while it runs, and is never made to wait for it.                                                       |
| NFR-PERF-06  | Should   | Supports 5 people using the system at once without noticeable slowdown.                                                                                      |

## 4. Data integrity and durability (DATA)

Losing the inventory means recounting 400 items by hand across three locations.

| ID           | Priority | Requirement                                                                                                                              |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-DATA-01  | Must     | No confirmed action is silently lost. If it cannot be saved, say so.                                                                     |
| NFR-DATA-02  | Must     | Movements are an append-only event log; status is derived. Makes offline merges safe and gives real history.                             |
| NFR-DATA-02a | Must     | The server keeps the full log forever. Devices sync only the last 90 days, so an offline copy does not grow without limit (NFR-PERF-04). |
| NFR-DATA-02b | Must     | Capture audit events from the first release. History cannot be backfilled. A viewer for them can come later.                             |
| NFR-DATA-03  | Must     | Automatic daily backup of the server database, kept for 30 days.                                                                         |
| NFR-DATA-03a | Must     | Backups leave the machine. A copy on the same box is not a backup when the risk is that box being stolen, flooded, or failing.           |
| NFR-DATA-04  | Must     | Restore from backup is tested at least once before go-live and documented.                                                               |
| NFR-DATA-05  | Could    | The Quartermaster can export everything to CSV, with no developer help.                                                                  |
| NFR-DATA-06  | Should   | A device that has been offline for 30 days can still sync without data loss.                                                             |
| NFR-DATA-07  | Should   | Deleted records are recoverable for 30 days.                                                                                             |

## 5. Security and privacy (SEC)

We hold the names and email addresses of adult Scouters, and nothing else. No youth data means no parental consent to
manage and no Scouts Canada youth-data obligations to meet.

| ID         | Priority | Requirement                                                                                                                                                                                                                                    |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-SEC-01 | Must     | All traffic over HTTPS.                                                                                                                                                                                                                        |
| NFR-SEC-02 | Must     | Passwords hashed with argon2 or bcrypt. Never plain text, never reversible. Adopting FR-USR-07 (sign in with Google) would remove stored passwords altogether, and this requirement with them.                                                 |
| NFR-SEC-03 | Must     | Public item pages expose only the item name, the group name, and a contact route. No personal data, no prices, no history.                                                                                                                     |
| NFR-SEC-04 | Must     | Public QR identifiers are not guessable. Incrementing a number must not enumerate the inventory.                                                                                                                                               |
| NFR-SEC-05 | Must     | Store name, email, role. Nothing else. Accounts are for registered adult Scouters only; the system holds no youth records.                                                                                                                     |
| NFR-SEC-06 | Must     | Offline data is protected by the device lock. A lost phone holds a full copy of the inventory, so the lock is the control that matters.                                                                                                        |
| NFR-SEC-07 | Should   | Deactivating a user ends their access at the server at once, and on a device at its next sync. Sessions do not expire (FR-USR-05), so a device that never reconnects keeps working offline. The device lock is the control there (NFR-SEC-06). |
| NFR-SEC-08 | Should   | Personal data is stored in Canada, or the group is told where it is stored.                                                                                                                                                                    |
| NFR-SEC-09 | Should   | Dependencies are scanned for known vulnerabilities on every build.                                                                                                                                                                             |

## 6. Maintainability (MAINT)

Volunteers maintain this, in evenings, with turnover. Whoever inherits it in three years did not write it.

| ID           | Priority | Requirement                                                                                                                                                                              |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-MAINT-01 | Must     | Open source under a permissive licence, so other groups can use and improve it.                                                                                                          |
| NFR-MAINT-02 | Must     | Boring, widely known technology. A stack a hobbyist can pick up beats a clever one.                                                                                                      |
| NFR-MAINT-03 | Must     | One command sets up a working development environment on a clean machine.                                                                                                                |
| NFR-MAINT-04 | Must     | Tests cover check-out, check-in, and sync merges. That is where a silent bug costs most.                                                                                                 |
| NFR-MAINT-05 | Should   | Continuous integration runs tests on every pull request.                                                                                                                                 |
| NFR-MAINT-06 | Should   | Database schema changes ship as versioned migrations that run on deploy.                                                                                                                 |
| NFR-MAINT-07 | Should   | Documented setup path for a second Scout group to run their own copy.                                                                                                                    |
| NFR-MAINT-08 | Won't    | Multi-group support in one instance, so groups can share hosting.                                                                                                                        |
| NFR-MAINT-09 | Must     | Document how to move the server to another machine or another volunteer's house. Self-hosting concentrates the bus factor in one spare room; write the escape route before it is needed. |

## 7. Availability and operations (OPS)

| ID         | Priority | Requirement                                                                                      |
| ---------- | -------- | ------------------------------------------------------------------------------------------------ |
| NFR-OPS-01 | Must     | A server outage does not stop check-out. Offline-first makes the server non-critical during use. |
| NFR-OPS-02 | Must     | Server maintenance can happen any time without warning users.                                    |
| NFR-OPS-03 | Should   | Error logs and recent sync failures are readable without a debugger.                             |
| NFR-OPS-04 | Should   | Sync failures are visible to the Quartermaster, not only in server logs.                         |
| NFR-OPS-05 | Could    | Health check endpoint and uptime alerting.                                                       |

## 8. Accessibility (A11Y)

| ID          | Priority | Requirement                                                            |
| ----------- | -------- | ---------------------------------------------------------------------- |
| NFR-A11Y-01 | Should   | Meets WCAG 2.2 Level AA for contrast, focus order, and form labelling. |
| NFR-A11Y-02 | Should   | Usable at 200% text zoom without horizontal scrolling.                 |
| NFR-A11Y-03 | Should   | Colour is never the only signal. Pair it with text or an icon.         |
| NFR-A11Y-04 | Could    | Screen reader tested on the check-out flow.                            |

## 9. Out of scope (this release)

Listed so nobody asks twice.

- Payments, billing, or subscriptions
- Gear lending between Scout groups
- Native iOS or Android apps
- Integration with Scouts Canada membership systems
- Purchase orders and supplier management
- Barcode formats other than QR
