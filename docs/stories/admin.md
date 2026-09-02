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

## S-ADM-06 Retire a tent, then change your mind

A tent is written off after a pole snaps beyond repair. Months later a replacement pole turns up and it goes back into
service.

- Retiring hides the item and blocks check-out; it does not delete it
- Retired items can be listed on demand and brought back
- An unretired item keeps its code and its whole history

Covers: FR-INV-04, FR-INV-05

## S-ADM-07 A lost phone

A Scouter loses their phone. It holds a full copy of the inventory. The Admin revokes that device without closing the
account, and the Scouter carries on from a new one.

- One device can be revoked without deactivating the person
- The account keeps working everywhere else
- What was on the lost phone is protected by the device lock

Covers: FR-USR-14, NFR-SEC-06

## S-ADM-08 A forgotten password

A Scouter cannot sign in. The Admin generates a reset link. If the group has filled in a mail account the server sends
it; if not, the Admin copies the link and sends it however they normally talk.

- Reset is a one-time link, whether it is mailed or passed on by hand
- Mail is optional: no service has to be run or paid for
- An Admin can test the mail account against their own address first

Covers: FR-USR-12, FR-USR-15, FR-USR-16
