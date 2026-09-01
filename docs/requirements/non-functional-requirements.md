# Non-functional requirements

How well the system must work. These are drafts for review — several encode
choices that are still open. See [open-questions.md](open-questions.md).

---

## 1. Deployment model (DEP)

This is the decision everything else hangs on. Two candidates:

**A. Hosted service.** One server on the internet. Phones and tablets use it
through a browser. Simple to build, simple to operate, and dead at the lockers
when the signal drops.

**B. Offline-first client.** The app runs in the browser as a progressive web
app, keeps a full copy of the inventory on the device, and works with no
network. It syncs when a connection returns. The server becomes a sync point
rather than the source of truth during use.

**Recommendation: build B from the start.** Retrofitting offline behaviour onto
a server-first design means reworking data access, conflict handling, and most
of the UI. The cost is highest at the beginning and only goes up.

A third option — an iPad left in the locker running standalone — is a subset of
B with sync switched off, so B covers it without extra work. Note that two of
our three locations are unheated or outdoors, so a permanently stationed tablet
is a weak fallback. Design for the phones people carry.

| ID | Priority | Requirement |
|---|---|---|
| NFR-DEP-01 | Must | Runs in a mobile browser. No app store install, no per-device provisioning. |
| NFR-DEP-02 | Must | Installable to a phone home screen and launchable like an app. |
| NFR-DEP-03 | Must | Core flows (search, check-out, check-in) work with no network. |
| NFR-DEP-04 | Must | A single self-hosted server instance serves the whole group. |
| NFR-DEP-05 | Should | Deployable by one volunteer in under an hour, from written instructions. |
| NFR-DEP-06 | Should | Hosting costs under $10 CAD per month, or nothing on a free tier. |
| NFR-DEP-07 | Could | Runs on a small box on site with no internet at all, syncing when it gets a connection. |

## 2. Usability (USE)

The system competes with walking into the locker and taking a tent. If it is
slower than that, people will take the tent.

| ID | Priority | Requirement |
|---|---|---|
| NFR-USE-01 | Must | Scan to confirmed check-out takes under 5 seconds per item once the scanner is open. |
| NFR-USE-02 | Must | A batch of 10 items scans in one continuous session with no per-item confirmation tap. |
| NFR-USE-03 | Must | Usable one-handed on a phone, in the dark, with cold or gloved hands. Tap targets at least 44x44 px; primary actions in the lower half of the screen. |
| NFR-USE-04 | Must | A new Scouter can complete a check-out without training or written instructions. |
| NFR-USE-05 | Must | Works in current Safari on iOS and Chrome on Android. These are what our volunteers have. |
| NFR-USE-06 | Should | Readable outdoors in direct daylight and in an unlit locker: high contrast, minimum 16 px body text. |
| NFR-USE-07 | Should | Works on an older iPad, including one several OS versions behind, in case a shared device is stationed on site. |
| NFR-USE-08 | Should | Every destructive action is undoable, or confirmed first. |
| NFR-USE-09 | Could | Full keyboard operation with a bluetooth barcode scanner, for bulk work at a desk. |

## 3. Performance (PERF)

| ID | Priority | Requirement |
|---|---|---|
| NFR-PERF-01 | Must | Search results appear within 200 ms of a keystroke on 500 items. |
| NFR-PERF-02 | Must | Any list or detail page renders within 1 second on a 4-year-old mid-range phone. |
| NFR-PERF-03 | Must | The app starts within 3 seconds from the home screen icon, offline. |
| NFR-PERF-04 | Should | The full offline dataset for 500 items with photos stays under 50 MB on device. |
| NFR-PERF-05 | Should | Sync of a day's work (about 100 events) completes in under 30 seconds on a weak connection. |
| NFR-PERF-06 | Should | Supports 5 people using the system at once without noticeable slowdown. |

## 4. Data integrity and durability (DATA)

Losing the inventory means rebuilding it by hand from 400 items across three
locations.

| ID | Priority | Requirement |
|---|---|---|
| NFR-DATA-01 | Must | No confirmed user action is silently lost. If an action cannot be saved, the user is told. |
| NFR-DATA-02 | Must | Gear movements are stored as an append-only event log. Current status is derived from it. This makes offline merges safe and gives a real history. |
| NFR-DATA-03 | Must | Automatic daily backup of the server database, kept for 30 days. |
| NFR-DATA-04 | Must | Restore from backup is tested at least once before go-live and documented. |
| NFR-DATA-05 | Must | Full data export to CSV at any time, by the Quartermaster, with no developer help. |
| NFR-DATA-06 | Should | A device that has been offline for 30 days can still sync without data loss. |
| NFR-DATA-07 | Should | Deleted records are recoverable for 30 days. |

## 5. Security and privacy (SEC)

The system holds names and email addresses of adults and possibly youth. Scouts
Canada has expectations about youth data, and so do parents.

| ID | Priority | Requirement |
|---|---|---|
| NFR-SEC-01 | Must | All traffic over HTTPS. |
| NFR-SEC-02 | Must | Passwords stored with a modern password hash (argon2 or bcrypt). Never in plain text, never reversible. |
| NFR-SEC-03 | Must | Public item pages expose only the item name, the group name, and a contact route. No personal data, no prices, no history. |
| NFR-SEC-04 | Must | Public QR identifiers are not guessable. An attacker must not be able to enumerate the inventory by incrementing a number. |
| NFR-SEC-05 | Must | Store the minimum personal data needed: name, email, role. No youth records, no addresses, no phone numbers unless a later requirement forces it. |
| NFR-SEC-06 | Must | Data on an offline device is protected by the device lock. A shared on-site device holds no passwords in plain text. |
| NFR-SEC-07 | Should | Removing a user removes their access immediately, including on offline devices at next sync. |
| NFR-SEC-08 | Should | Personal data is stored in Canada, or the group is told where it is stored. |
| NFR-SEC-09 | Should | Dependencies are scanned for known vulnerabilities on every build. |

## 6. Maintainability (MAINT)

This will be maintained by volunteers, in evenings, with turnover. Whoever
inherits it in three years will not be the person who wrote it.

| ID | Priority | Requirement |
|---|---|---|
| NFR-MAINT-01 | Must | Open source, under a permissive licence, so other groups can use and improve it. |
| NFR-MAINT-02 | Must | Boring, widely known technology. Favour a stack a hobbyist can pick up over one that is clever. |
| NFR-MAINT-03 | Must | One command sets up a working development environment on a clean machine. |
| NFR-MAINT-04 | Must | Automated tests cover check-out, check-in, and sync merge behaviour. These are where a silent bug costs the most. |
| NFR-MAINT-05 | Should | Continuous integration runs tests on every pull request. |
| NFR-MAINT-06 | Should | Database schema changes ship as versioned migrations that run on deploy. |
| NFR-MAINT-07 | Should | Documented setup path for a second Scout group to run their own copy. |
| NFR-MAINT-08 | Could | Multi-group support in one instance, so groups can share hosting. |

## 7. Availability and operations (OPS)

| ID | Priority | Requirement |
|---|---|---|
| NFR-OPS-01 | Must | A server outage does not stop gear check-out. Offline-first makes the server non-critical during use. |
| NFR-OPS-02 | Must | Server maintenance can happen any time without warning users. |
| NFR-OPS-03 | Should | An operator can see error logs and recent sync failures without a debugger. |
| NFR-OPS-04 | Should | Sync failures are visible to the Quartermaster, not only in server logs. |
| NFR-OPS-05 | Could | Health check endpoint and uptime alerting. |

## 8. Accessibility (A11Y)

| ID | Priority | Requirement |
|---|---|---|
| NFR-A11Y-01 | Should | Meets WCAG 2.2 Level AA for contrast, focus order, and form labelling. |
| NFR-A11Y-02 | Should | Usable at 200% text zoom without horizontal scrolling. |
| NFR-A11Y-03 | Should | Colour is never the only way status is shown. Pair it with text or an icon. |
| NFR-A11Y-04 | Could | Screen reader tested on the check-out flow. |

## 9. Out of scope (this release)

Named so nobody has to ask twice.

- Payments, billing, or subscriptions
- Gear lending between Scout groups
- Native iOS or Android apps
- Integration with Scouts Canada membership systems
- Purchase orders and supplier management
- Barcode formats other than QR
