# Open questions

Decisions needed before design. Each one changes what we build.

## Blocking

**Q1. Offline-first, or hosted and see how it goes?**
The single biggest fork. Offline-first costs more up front and shapes the data
model. Hosted is faster to a working system but may be unusable in the shed.
Recommendation in [NFR-DEP](non-functional-requirements.md#1-deployment-model-dep):
build offline-first.

**Q2. How bad is connectivity at each location, really?**
We are designing around an assumption. Before committing, stand in the Cold
locker, the Warm locker, and the Garry Point yard and run a speed test on the
phones people actually carry. Record the result for each. If it is merely slow,
a hosted app with aggressive caching may be enough. If one location is fine and
another is dead, that also changes the answer.

**Q3. One shared on-site device, personal phones, or both?**
Changes the sign-in model (FR-USR-06). A shared iPad needs fast identity
switching. Personal phones need real accounts. Supporting both is more work than
either.

The Cold locker is unheated and the Garry Point yard is outdoors, so a tablet
left on site year-round will not survive a winter in either. If we want a shared
device it likely lives in the Warm locker, or someone carries it in and out.
That weakens the case for the shared-device option and strengthens the case for
personal phones — which makes offline-first (Q1) more important, not less.

## Needed before build

**Q4. Do we track individual items or quantities?**
"4 tents" is far less work to set up than 4 labelled, individually tracked
tents. But quantity tracking cannot tell you which tent has the broken pole.
FR-INV-03 assumes we need both. Confirm.

**Q5. Are youth ever users?**
Drives the privacy requirements. If only registered adult Scouters have
accounts, NFR-SEC stays simple.

**Q6. What is the label budget and stock?**
Requirements assume Avery 6576 (1.75" x 1.25", 1600 stickers, about 5 cents
each). Durability is unproven, and gear in the Garry Point yard sees rain, sun,
and freeze-thaw. Worth sticking a test sheet on real outdoor gear for a season
before printing 400.

**Q7. Who hosts, and where?**
Affects NFR-DEP-06 and NFR-SEC-08. A free tier on a cloud provider is cheapest
but may store data outside Canada.

**Q8. Do we need to import existing records?**
FR-SET-06 assumes a spreadsheet exists. If the current inventory is on paper,
the first load is a data-entry project and should be planned as one.

## Worth deciding early, cheap to defer

**Q9. Kits (FR-INV-11).** Real convenience for patrol boxes, real modelling
complexity. Could be a later release.

**Q10. Reservations (FR-RES).** Does the group actually double-book gear today,
or is the calendar on the hall wall sufficient? If conflicts are rare, this
whole section could drop to Could.

**Q11. Photos (FR-INV-08).** Useful for condition disputes. Costs storage and
sync bandwidth on an offline device.
