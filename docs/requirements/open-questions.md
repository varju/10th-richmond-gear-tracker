# Open questions

Each one changes what we build.

## Blocking

**Q1. Offline-first, or hosted and see how it goes?**
The big fork. Offline-first costs more up front and shapes the data model.
Hosted is faster to something working, and may be unusable at the lockers.
Recommendation: offline-first. See
[NFR-DEP](non-functional-requirements.md#1-deployment-model-dep).

**Q2. How bad is the signal, really?**
We are designing around an assumption. Stand in the Cold locker, the Warm
locker, and the yard, and run a speed test on the phones people carry. Record
each. Merely slow may be survivable with caching. One dead location changes the
answer.

**Q3. Shared on-site device, personal phones, or both?**
Drives the sign-in model (FR-USR-06). A shared iPad needs fast identity
switching; phones need real accounts. Both is more work than either.

The Cold locker and the yard will kill a tablet over a winter. A shared device
would have to live in the Warm locker or be carried in and out. That weakens
the shared-device case and strengthens offline-first (Q1).

## Before build

**Q4. Individual items, or quantities?**
"4 tents" is far less setup than 4 labelled tents. But it cannot tell you which
tent has the broken pole. FR-INV-03 assumes we need both. Confirm.

**Q5. Are youth ever users?**
Drives the privacy requirements. Adults only keeps NFR-SEC simple.

**Q6. Label stock and budget?**
Requirements assume Avery 6576 (1.75" x 1.25", 1600 stickers, ~5c each).
Durability is unproven, and yard gear sees rain, sun, and freeze-thaw. Stick a
test sheet on real outdoor gear for a season before printing 400.

**Q7. Who hosts, and where?**
Affects NFR-DEP-06 and NFR-SEC-08. A free cloud tier is cheapest but may store
data outside Canada.

**Q8. Is there a spreadsheet to import?**
FR-SET-06 assumes one exists. If the inventory is on paper, the first load is a
data-entry project. Plan it as one.

**Q12. Is a trailer a place or a thing?**
Trailers sit in the yard and hold gear, so they are sub-locations (FR-SET-03a).
They are also gear: they travel, they need repairs, they have value. If both,
gear inside moves when the trailer moves and "where is it" has two answers.
First cut: sub-locations only, trailer maintenance tracked elsewhere. Confirm.

**Q13. How stable are the shelf numbers?**
FR-SET-03b assumes renumbering happens and must be cheap. Reorganised yearly,
and home locations become a burden. Unchanged for a decade, and we can lean on
them harder.

## Cheap to defer

**Q9. Kits (FR-INV-11).** Real convenience for patrol boxes, real modelling
complexity. Could be a later release.

**Q10. Reservations (FR-RES).** Does the group actually double-book gear, or is
the calendar on the hall wall enough? If conflicts are rare, drop the section
to Could.

**Q11. Photos (FR-INV-08).** Useful for condition disputes. Costs storage and
sync bandwidth on device.
