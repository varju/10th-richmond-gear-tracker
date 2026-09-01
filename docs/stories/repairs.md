# Repairs

Reporting broken gear and getting it fixed.

## S-REP-01 Report a fault

Any Scouter raises a ticket against an item, with a description and, if they are in signal, a photo.

- Any signed-in user can raise a ticket
- A photo is optional; taken offline, it uploads at the next sync

Covers: FR-REP-01, FR-REP-02, FR-INV-11

## S-REP-02 Warn the next person

A tent with an open ticket is visibly flagged wherever it appears, including when someone tries to take it.

- Open tickets show in lists and at check-out
- A reserved item with an open ticket warns but does not block

Covers: FR-REP-05, FR-RES-08

## S-REP-03 Work the ticket

The Quartermaster asks for detail in a comment, gets a reply, and updates the state as the repair progresses.

- Comments can be added and edited through the life of the repair
- Cost, time and parts go in a comment; there are no structured fields
- States run open, in progress, resolved, won't fix

Covers: FR-REP-03, FR-REP-06

## S-REP-04 Remember what happened

A year later, someone looks at the tent and sees every repair it has had.

- Repair history stays on the item after tickets close

Covers: FR-REP-04, FR-INV-09
