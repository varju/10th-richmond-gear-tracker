# Offline

What happens with no signal. These are not edge cases; this is the normal condition at the lockers.

## S-OFF-01 A normal evening

A Scouter checks out eight items in the Cold locker with no signal at all. Everything works.

- Search, check-out and check-in need no network
- The work is stored on the phone

Covers: FR-OFF-01, FR-OFF-02, NFR-DEP-02

## S-OFF-02 Knowing there is work to send

While records are unsent, the app says so on every screen, because there is no moment when a session ends.

- A persistent banner shows the unsent count
- It stays until the records go

Covers: FR-OFF-04

## S-OFF-03 Getting home

The Scouter opens the app on the sofa. It syncs without being asked, and without making them wait.

- Sync happens on app open and on regaining connectivity
- There is no sync button
- The screen stays usable while it runs

Covers: FR-OFF-02, FR-OFF-03, NFR-PERF-06

## S-OFF-04 The phone that stays in a pocket

A Scouter never reopens the app. Nothing syncs, because nothing on iOS can sync a closed app.

- The count is waiting when they next open it
- After 3 days, opening the app interrupts rather than showing a banner
- The records survive the wait: the app is installed to the home screen, so the 7-day clearing does not apply

Covers: FR-OFF-04, FR-OFF-09, NFR-DEP-06, NFR-DATA-11

## S-OFF-06 A new phone

A Scouter replaces their phone and signs in on the new one. The whole inventory is there, including gear nobody has
touched in two years.

- Setup fetches current state, not two years of history
- Items last moved outside the retention window are still present
- Nothing on the old phone had to be exported

Covers: FR-OFF-14, NFR-DATA-03

## S-OFF-05 Two phones, one tent

Two Scouters both act on the same item while offline. Neither loses work.

- Both sets of events land at sync
- Replay produces one ordered history
- What a machine cannot settle goes to the Quartermaster with both versions

Covers: FR-OFF-05, FR-OFF-10, NFR-DATA-02
