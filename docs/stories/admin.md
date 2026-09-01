# Admin

Users, roles, and the record of who did what.

## S-ADM-01 Add a Scouter

An Admin invites a new volunteer, who signs in on their own phone and stays signed in.

- Invitation is by email address
- The session does not expire
- No password is typed in a cold locker

Covers: FR-USR-01, FR-USR-04, FR-USR-07

## S-ADM-02 Someone leaves

An Admin deactivates a volunteer who has moved away. Their access ends, but their history does not.

- Access ends at the server immediately
- A device that has not synced keeps working until it does
- The audit log still shows what they did

Covers: FR-USR-04, FR-USR-06, NFR-SEC-07

## S-ADM-03 Their last sync still counts

The departing volunteer's phone syncs a week later, carrying real gear movements from before they left.

- The pending records are accepted
- They are attributed to that person
- The session then ends

Covers: FR-OFF-06, FR-OFF-07

## S-ADM-04 Nobody locks the group out

An Admin tries to demote the only remaining Admin, and cannot.

- The last Admin cannot be demoted or deactivated

Covers: FR-USR-03

## S-ADM-05 What changed, and who changed it

The Quartermaster wants to know why a tent's home moved last month.

- Item edits, movements, and user changes are all recorded
- Edits record the field, its old value, and its new value
- An item's history is readable from its page

Covers: FR-USR-05, FR-USR-09
