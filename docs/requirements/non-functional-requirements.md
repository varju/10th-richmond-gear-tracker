# Non-functional requirements

How well the system must work. Drafts for review; several encode open choices.
See [open-questions.md](open-questions.md).

---

## 1. Deployment model (DEP)

Everything else hangs on this.

**A. Hosted service.** One server, used through a browser. Simple to build and
operate. Dead at the lockers when the signal drops.

**B. Offline-first client.** A progressive web app holding a full copy of the
inventory on device. Works with no network, syncs when one returns. The server
is a sync point, not the source of truth during use.

**Recommendation: B, from the start.** Retrofitting offline onto a server-first
design means reworking data access, conflict handling, and most of the UI.

An iPad left in the locker is B with sync off, so B covers it. But two of three
locations are unheated or outdoors, so a stationed tablet is a weak fallback.
Design for the phones people carry.

| ID | Priority | Requirement |
|---|---|---|
| NFR-DEP-01 | Must | Runs in a mobile browser. No app store install, no per-device provisioning. |
| NFR-DEP-02 | Must | Installs to a phone home screen and launches like an app. |
| NFR-DEP-03 | Must | Core flows (search, check-out, check-in) work with no network. |
| NFR-DEP-04 | Must | A single self-hosted server instance serves the whole group. |
| NFR-DEP-05 | Should | One volunteer can deploy it in under an hour from written instructions. |
| NFR-DEP-06 | Should | Hosting costs under $10 CAD per month, or nothing on a free tier. |
| NFR-DEP-07 | Could | Runs on a small box on site with no internet at all, syncing when it gets a connection. |

## 2. Usability (USE)

This competes with walking into a locker and taking a tent. Slower than that,
and people take the tent.

| ID | Priority | Requirement |
|---|---|---|
| NFR-USE-01 | Must | Under 5 seconds from scan to confirmed check-out, once the scanner is open. |
| NFR-USE-02 | Must | A batch of 10 items scans in one continuous session with no per-item confirmation tap. |
| NFR-USE-03 | Must | Usable one-handed on a phone, in the dark, with cold or gloved hands. Tap targets at least 44x44 px; primary actions in the lower half of the screen. |
| NFR-USE-04 | Must | A new Scouter completes a check-out with no training. |
| NFR-USE-05 | Must | Works in current Safari on iOS and Chrome on Android. That is what volunteers carry. |
| NFR-USE-06 | Should | Readable outdoors in direct daylight and in an unlit locker: high contrast, minimum 16 px body text. |
| NFR-USE-07 | Should | Works on an older iPad several OS versions behind, in case we station a shared device. |
| NFR-USE-08 | Should | Every destructive action is undoable, or confirmed first. |
| NFR-USE-09 | Could | Full keyboard operation with a bluetooth scanner, for bulk work at a desk. |

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

Losing the inventory means recounting 400 items by hand across three locations.

| ID | Priority | Requirement |
|---|---|---|
| NFR-DATA-01 | Must | No confirmed action is silently lost. If it cannot be saved, say so. |
| NFR-DATA-02 | Must | Movements are an append-only event log; status is derived. Makes offline merges safe and gives real history. |
| NFR-DATA-03 | Must | Automatic daily backup of the server database, kept for 30 days. |
| NFR-DATA-04 | Must | Restore from backup is tested at least once before go-live and documented. |
| NFR-DATA-05 | Must | The Quartermaster can export everything to CSV, with no developer help. |
| NFR-DATA-06 | Should | A device that has been offline for 30 days can still sync without data loss. |
| NFR-DATA-07 | Should | Deleted records are recoverable for 30 days. |

## 5. Security and privacy (SEC)

We hold names and email addresses. Scouts Canada and parents both have
expectations about youth data.

| ID | Priority | Requirement |
|---|---|---|
| NFR-SEC-01 | Must | All traffic over HTTPS. |
| NFR-SEC-02 | Must | Passwords hashed with argon2 or bcrypt. Never plain text, never reversible. |
| NFR-SEC-03 | Must | Public item pages expose only the item name, the group name, and a contact route. No personal data, no prices, no history. |
| NFR-SEC-04 | Must | Public QR identifiers are not guessable. Incrementing a number must not enumerate the inventory. |
| NFR-SEC-05 | Must | Store name, email, role. Nothing else, unless a later requirement forces it. No youth records. |
| NFR-SEC-06 | Must | Offline data is protected by the device lock. A shared device holds no plain-text passwords. |
| NFR-SEC-07 | Should | Removing a user removes their access immediately, including on offline devices at next sync. |
| NFR-SEC-08 | Should | Personal data is stored in Canada, or the group is told where it is stored. |
| NFR-SEC-09 | Should | Dependencies are scanned for known vulnerabilities on every build. |

## 6. Maintainability (MAINT)

Volunteers maintain this, in evenings, with turnover. Whoever inherits it in
three years did not write it.

| ID | Priority | Requirement |
|---|---|---|
| NFR-MAINT-01 | Must | Open source under a permissive licence, so other groups can use and improve it. |
| NFR-MAINT-02 | Must | Boring, widely known technology. A stack a hobbyist can pick up beats a clever one. |
| NFR-MAINT-03 | Must | One command sets up a working development environment on a clean machine. |
| NFR-MAINT-04 | Must | Tests cover check-out, check-in, and sync merges. That is where a silent bug costs most. |
| NFR-MAINT-05 | Should | Continuous integration runs tests on every pull request. |
| NFR-MAINT-06 | Should | Database schema changes ship as versioned migrations that run on deploy. |
| NFR-MAINT-07 | Should | Documented setup path for a second Scout group to run their own copy. |
| NFR-MAINT-08 | Could | Multi-group support in one instance, so groups can share hosting. |

## 7. Availability and operations (OPS)

| ID | Priority | Requirement |
|---|---|---|
| NFR-OPS-01 | Must | A server outage does not stop check-out. Offline-first makes the server non-critical during use. |
| NFR-OPS-02 | Must | Server maintenance can happen any time without warning users. |
| NFR-OPS-03 | Should | Error logs and recent sync failures are readable without a debugger. |
| NFR-OPS-04 | Should | Sync failures are visible to the Quartermaster, not only in server logs. |
| NFR-OPS-05 | Could | Health check endpoint and uptime alerting. |

## 8. Accessibility (A11Y)

| ID | Priority | Requirement |
|---|---|---|
| NFR-A11Y-01 | Should | Meets WCAG 2.2 Level AA for contrast, focus order, and form labelling. |
| NFR-A11Y-02 | Should | Usable at 200% text zoom without horizontal scrolling. |
| NFR-A11Y-03 | Should | Colour is never the only signal. Pair it with text or an icon. |
| NFR-A11Y-04 | Could | Screen reader tested on the check-out flow. |

## 9. Out of scope (this release)

Listed so nobody asks twice.

- Payments, billing, or subscriptions
- Gear lending between Scout groups
- Native iOS or Android apps
- Integration with Scouts Canada membership systems
- Purchase orders and supplier management
- Barcode formats other than QR
