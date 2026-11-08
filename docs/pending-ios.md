# Pending iOS release

App changes since `ios-1.0.3-365` that reach iPhones only through the next release.

## Functional

What the app does differently.

- Change event on gear linked to an event relinks it to the corrected name's event, making one for today if there is
  none, and takes the gear off the old event's list if only that check-out added it.
- A check-out under an event name that no reservation takes makes a reservation for today. A later check-out under its
  name joins it, and moves its end date out to that day if it ended in the last week with gear still out.
- A check-out under a planned event's name links to that event and joins its gear list.
- Gear can be sent home to be cleaned by a named person, singly or by count from a stack. The name autocompletes, a
  return from a stack names whose share it is, and What is out shows the cleaner. **Back from cleaning** marks it back
  with the Scouter. Gear is sent home once it is out, not while it is in, and keeps its event and reservation, but is
  not counted as packed while it is at a cleaner's home. A stack counts as packed only what is still out for the event.
- A single item sent home keeps its days out and its place in the history, which reads "Sent home with", and an open
  double check-out stays open.
- A stack's line on an event no longer grows when some come back or go home and the same number is packed again.
- Cleaner suggestions include names from stacks and from single items sent home.
- A stack's page can change the name of a family its share was sent home with.
- Correcting a cleaner's name renames the whole share, and does nothing once the gear is back.
- A recount's reason is optional.
- Only what cannot be undone asks first. Mark missing, making a single item, and turning an item into several units now
  act on one tap; deleting, removing a photo, cancelling an event and making a counted stack ask with "Really …?" on the
  same button, which turns back after a few seconds.
- An item's home can be a person ("Kept by Sam"): the gear counts as in, and the Home filter lists people.
- An event's gear lists are in alphabetical order. Lists sorted by name put 2 before 10.
- Scanning an unassigned code no longer emphasises one choice. "Another of…" is now "Add a unit of…", and shows only
  when there is something to add a unit of.
- After a move on a single item's page, the move buttons pause briefly so a second tap cannot undo it.
- Back from changing the check-out event returns to Events.
- An item's description can have bold, italic, links and bullet lists, and a URL in it is a link. A backslash shows a
  star as typed, and a description over 5,000 characters shows as typed.
- Back from changing an item's event returns to the item.
- A unit's page can add another unit of the same generic.
- A stack that comes back short has **Mark missing**, **Found** and **Write off**. The missing count stays owned until
  written off, and is shown on the stack's page and list row. The Missing filter finds it.
- The item list shows a generic's units as in and out, the same as a stack, plus how many are missing.
- The item list has a **Needs** filter for gear with no QR code, no location, or no shelf.
- A new item labelled one by one takes **How many** and makes that many units. Editing an item into several takes **How
  many in all**.
- Scanning a fresh code and picking a generic puts the code on its next unit waiting for one, before making a new unit.
- A move's confirmation stays up for 4 seconds, with a tick, and goes sooner on the scanner if the next card opens. A
  single item's or unit's page shows who has it, under its name, while it is out.
- The app no longer shows the code behind a QR sticker, and the scanner no longer takes a typed code. An item's Details
  say only whether it has a QR code.
- Changing the check-out event on the scanner shows its suggestions on their own line under the bar, in view on a phone.
- On a stack's count panel, a tap off **How many** closes the number pad, and the button scrolls above the keyboard.
- An item page offers **Duplicate…**, which opens a new item filled from it. A stack copies with a blank count; units
  have no Duplicate.
- Back after adding a QR code to an item, or saving an edited event, returns to the page the person came from instead of
  showing it twice.
- A unit can have its own purchase date. With none, its Details show the generic's, marked as from the generic.
- Gear with an empty weight and a capacity is weighed to see what is left. **Return** asks the weight, in lb or kg, or
  **Unknown**. **Weigh** and **Refilled** are on its page. The page and the list show "About 8 lb left (40%)", and a
  page says "Not weighed since it came back" when the item has been out since the last reading.
- Making a generic with no units single keeps its capacity.
- Tapping **Check out** on a counted stack no longer checks out 1 at once.
- Replacing a QR code asks "Really replace its QR code?" on a row styled like the others, and a confirm button keeps its
  own styling while asking.
- The weight prompt on a return closes, instead of failing, if a sync takes away the item's capacity.
- **Weigh** on a weighed item's page takes **Unknown**, which clears what is left.
- On the pack list, a fully packed line moves under **Show packed** instead of reading "8 of 8". An event's list says "—
  packed" once a line is full.
- Tapping the unsent banner, or **Unsent records** in Settings, lists what is waiting to send and why the last sync
  failed.
- Checking out more of a stack than are in is refused. It asks "Are there more here?" and offers **Recount**, then the
  check-out.

## Chores

- Tidied the weight check in Weigh.
- The item list builds faster.
