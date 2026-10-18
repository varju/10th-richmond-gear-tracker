# Tasks

The build, in order. See [architecture.md](architecture.md) for why, and [stories/](stories/) for what each step is for.

**Delete tasks from this file as they are committed.** This file shrinks to nothing. It is not a changelog; git is the
changelog.

Milestones are ordered by risk, not by feature value. M0 comes first because a bad result there changes the project.

---

## M0 — Prove the scanner

Passed indoors on two iPhones: worst single acquisition 1.58 s against a 2 s bar, no camera dropouts. Numbers are in
[architecture.md](architecture.md#what-m0-measured). What is left needs a locker, or label stock.

- [ ] Repeat in an unlit locker, and with gloves on
- [ ] Add those numbers to architecture.md

Deferred until the first sheet is printed on real stock (32 labels of 1.75 x 1.25 in). Not blocked on us, and not
holding anything up:

- [ ] Confirm the sheet registers on real stock, and record the margins for FR-TAG-02
- [ ] Test through a scuffed sticker and a wet one

## M6 — Items and codes

Built. What is left waits on other work:

- [ ] Check the printed sheet against the real stock and fix `labels.py` if the margins are off (FR-TAG-02)

## M9 — Go live

First real use. Everything in the requirements that is built is built; going live buys feedback while the inventory is
fresh from the labelling walk.

- [ ] Print code sheets and do the labelling walk (S-BOOT-02, S-BOOT-03)

Public pages come before the labelling walk, not after it. From the moment stickers go on gear, a stranger can scan one.

## M11 — iPhone app

- [ ] Time the [native scanner](architecture.md#native-scanner) in the app against the M0 table and its 2 s bar
- [ ] Submit for App Review, with a note asking for unlisted distribution
- [ ] Send the unlisted distribution request form

## Reservations follow-ups

- [ ] **Reservation from an event.** Today the only per-event view is the Out report sorted by reservation, and it shows
      only gear still out. Add a Should: the Reservations screen lists events with gear out under them and no
      reservation (hand-typed or calendar). One tap creates a reservation with that name, the calendar dates or first
      check-out to today, and links each item out under it (as FR-RES-17). The reservation page then becomes the event's
      view.
- [ ] **"It's with us" beside its item on wide screens.** `.items li > button.small` puts the action under the row at
      every width (`styles.css`). On wide screens, put it at the end of the row instead. No requirement change.
- [ ] **Show what is not packed yet, on the reservation page.** Today only the pack list (Check out, FR-RES-21) hides
      packed lines, and opening it starts packing. Add a Should: the reservation page marks each line packed or not
      (`remaining()` in `reservations.ts`) and offers a "Not packed" filter.
