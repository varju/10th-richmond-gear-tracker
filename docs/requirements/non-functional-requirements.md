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

| ID         | Priority | Requirement                                                                                                                                                                                                                  |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-DEP-01 | Must     | Runs in a mobile browser. No app store install, no per-device provisioning.                                                                                                                                                  |
| NFR-DEP-02 | Must     | Core flows (search, check-out, check-in) work with no network.                                                                                                                                                               |
| NFR-DEP-03 | Must     | A single self-hosted server instance serves the whole group.                                                                                                                                                                 |
| NFR-DEP-04 | Must     | Hosting costs nothing beyond the electricity of a box already running at home. Self-hosted at a volunteer's house.                                                                                                           |
| NFR-DEP-05 | Must     | The server is reachable from the internet without exposing the host's home network. Prefer an outbound tunnel over forwarding a port.                                                                                        |
| NFR-DEP-06 | Must     | Installs to a phone home screen and launches like an app. Not a convenience: iOS clears a browser tab's storage after 7 days without a visit, and home-screen apps are exempt. Unsent work would be destroyed (NFR-DATA-01). |
| NFR-DEP-09 | Must     | QR codes point at a domain the group already owns, not at the server's address. Moving the server (NFR-MAINT-05) must not invalidate 400 printed stickers.                                                                   |
| NFR-DEP-07 | Should   | One volunteer can deploy it in under an hour from written instructions.                                                                                                                                                      |
| NFR-DEP-08 | Could    | Runs on a small box on site with no internet at all, syncing when it gets a connection.                                                                                                                                      |

## 2. Usability (USE)

This competes with walking into a locker and taking a tent. Slower than that, and people take the tent.

| ID         | Priority | Requirement                                                                                                                                           |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-USE-01 | Must     | Under 5 seconds from scan to confirmed move, in either direction, once the scanner is open.                                                           |
| NFR-USE-02 | Must     | Ten items scan in one continuous session. One tap each, no other interaction unless the user chooses to edit.                                         |
| NFR-USE-03 | Must     | Usable one-handed on a phone, in the dark, with cold or gloved hands. Tap targets at least 44x44 px; primary actions in the lower half of the screen. |
| NFR-USE-04 | Must     | A new Scouter completes a check-out at the first attempt, using only what is on the screen.                                                           |
| NFR-USE-05 | Must     | Works in current Safari on iOS and Chrome on Android.                                                                                                 |
| NFR-USE-06 | Should   | Readable outdoors in direct daylight and in an unlit locker: high contrast, minimum 16 px body text.                                                  |
| NFR-USE-07 | Should   | Every destructive action is undoable, or confirmed first.                                                                                             |
| NFR-USE-08 | Could    | Full keyboard operation with a bluetooth scanner, for bulk work at a desk.                                                                            |
| NFR-USE-09 | Won't    | Withdrawn: support an older stationed iPad. Personal phones only.                                                                                     |

## 3. Performance (PERF)

| ID          | Priority | Requirement                                                                                                       |
| ----------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| NFR-PERF-01 | Must     | Search results appear within 200 ms of a keystroke on 500 items.                                                  |
| NFR-PERF-02 | Must     | Any list or detail page renders within 1 second on the baseline device, an iPhone SE 2nd generation.              |
| NFR-PERF-03 | Must     | The app starts within 3 seconds from the home screen icon, offline.                                               |
| NFR-PERF-04 | Must     | A day's work (about 100 events, roughly 30 KB) uploads in under 5 seconds on a 1 Mbps uplink.                     |
| NFR-PERF-05 | Must     | Pending events upload in one batched request, not one per event.                                                  |
| NFR-PERF-06 | Must     | Sync never blocks the screen. The user keeps scanning while it runs.                                              |
| NFR-PERF-07 | Should   | The offline dataset for 500 items stays under 10 MB on device. Records only; photos are never cached (FR-INV-11). |
| NFR-PERF-08 | Should   | 5 people using the system at once still meet every target in this section.                                        |

## 4. Data integrity and durability (DATA)

Losing the inventory means recounting 400 items by hand across three locations.

| ID          | Priority | Requirement                                                                                                                                                                                                                                  |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-DATA-01 | Must     | No confirmed action is silently lost. If it cannot be saved, say so.                                                                                                                                                                         |
| NFR-DATA-02 | Must     | Movements are an append-only event log; status is derived. Makes offline merges safe.                                                                                                                                                        |
| NFR-DATA-03 | Must     | The server keeps the full log forever. Devices hold a current-state snapshot plus the last 90 days of history (FR-OFF-14), so an offline copy does not grow without limit (NFR-PERF-07). Events a device has not yet sent are never trimmed. |
| NFR-DATA-04 | Must     | Capture audit events from the first release. History cannot be backfilled.                                                                                                                                                                   |
| NFR-DATA-05 | Must     | Automatic daily backup of the server database, kept for 30 days.                                                                                                                                                                             |
| NFR-DATA-06 | Must     | Backups leave the machine. A copy on the same box is not a backup.                                                                                                                                                                           |
| NFR-DATA-07 | Must     | Restore from backup is tested at least once before go-live and documented.                                                                                                                                                                   |
| NFR-DATA-11 | Must     | The app asks the browser for persistent storage and tells the user if it is refused. Best-effort storage can be evicted with unsent work in it.                                                                                              |
| NFR-DATA-12 | Must     | Timestamps are stored in UTC. Dates shown to users, and reservation date ranges, are America/Vancouver.                                                                                                                                      |
| NFR-DATA-08 | Should   | A device that has been offline for 30 days can still sync without data loss.                                                                                                                                                                 |
| NFR-DATA-13 | Should   | Every sync measures the offset between the device clock and the server clock. Recorded times are corrected by it, and the raw reading is kept. A phone with a wrong clock must not put wrong times in the history.                           |
| NFR-DATA-10 | Could    | The Quartermaster can export everything to CSV, with no developer help.                                                                                                                                                                      |
| NFR-DATA-09 | Won't    | Withdrawn: recover deleted records for 30 days. Nothing is deleted. Items retire (FR-INV-04) and the log is append-only (NFR-DATA-02); backups cover the rest.                                                                               |

## 5. Security and privacy (SEC)

We hold the names and email addresses of adult Scouters, and nothing else. No youth data means no parental consent to
manage and no Scouts Canada youth-data obligations to meet.

| ID         | Priority | Requirement                                                                                                                                                                                                 |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-SEC-01 | Must     | All traffic over HTTPS.                                                                                                                                                                                     |
| NFR-SEC-02 | Must     | Passwords hashed with argon2 or bcrypt. Never plain text, never reversible.                                                                                                                                 |
| NFR-SEC-03 | Must     | Public item pages expose only the item name, the group name, and a contact route. No personal data, no prices, no history.                                                                                  |
| NFR-SEC-04 | Must     | Public QR identifiers are not guessable. Incrementing a number must not enumerate the inventory.                                                                                                            |
| NFR-SEC-05 | Must     | An account stores name, email, and role. Nothing else about a person is a field. Free text people type (item notes, movement notes, found-gear contact) is not structured and no field asks for youth data. |
| NFR-SEC-06 | Must     | Offline data is protected by the device lock. A lost phone holds a full copy of the inventory.                                                                                                              |
| NFR-SEC-07 | Should   | Deactivating a user ends their access at the server at once, and on a device at its next sync. Sessions do not expire (FR-USR-07), so a device that never reconnects keeps working offline.                 |
| NFR-SEC-08 | Should   | Personal data is stored in Canada, or the group is told where it is stored.                                                                                                                                 |
| NFR-SEC-09 | Should   | Dependencies are scanned for known vulnerabilities on every build.                                                                                                                                          |

## 6. Maintainability (MAINT)

Volunteers maintain this, in evenings, with turnover. Whoever inherits it in three years did not write it.

| ID           | Priority | Requirement                                                                                                                       |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| NFR-MAINT-01 | Must     | Open source under a permissive licence.                                                                                           |
| NFR-MAINT-02 | Must     | Boring, widely known technology. A stack a hobbyist can pick up beats a clever one.                                               |
| NFR-MAINT-03 | Must     | One command sets up a working development environment on a clean machine.                                                         |
| NFR-MAINT-04 | Must     | Tests cover check-out, check-in, and sync merges.                                                                                 |
| NFR-MAINT-05 | Must     | Document how to move the server to another machine or another volunteer's house. Self-hosting concentrates the risk in one house. |
| NFR-MAINT-06 | Should   | Continuous integration runs tests on every pull request.                                                                          |
| NFR-MAINT-07 | Should   | Database schema changes ship as versioned migrations that run on deploy.                                                          |
| NFR-MAINT-08 | Should   | Documented setup path for a second Scout group to run their own copy.                                                             |
| NFR-MAINT-09 | Won't    | Multi-group support in one instance, so groups can share hosting.                                                                 |

## 7. Availability and operations (OPS)

| ID         | Priority | Requirement                                                              |
| ---------- | -------- | ------------------------------------------------------------------------ |
| NFR-OPS-01 | Must     | A server outage does not stop check-out.                                 |
| NFR-OPS-02 | Must     | Server maintenance can happen any time without warning users.            |
| NFR-OPS-03 | Should   | Error logs and recent sync failures are readable without a debugger.     |
| NFR-OPS-04 | Should   | Sync failures are visible to the Quartermaster, not only in server logs. |
| NFR-OPS-05 | Could    | Health check endpoint and uptime alerting.                               |

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
