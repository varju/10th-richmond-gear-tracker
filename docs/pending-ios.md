# Pending iOS release

App changes since `ios-1.0.4-487` that reach iPhones only through the next release.

## Functional

What the app does differently.

- Back returns to where the screen was scrolled at the tap, not a moment before.
- An item's page drops its Changes list. Admins get **Open in audit log**, showing that item's whole record.
- After a contents link in the guide, the app still counts the steps behind it, so Back retraces them.
- Back and Forward through the guide's contents links return each place to where it was scrolled.
- A tap on the status bar while a screen is returning to its scroll stops it there, and Back later returns to where the
  person was.
- After the app reloads, Back and Forward return each screen to where it was scrolled, not an older place.
- Search also finds gear by its description. Gear named for the words still lists first.
- A unit with no description of its own shows its generic's, marked as from it. Marking an item generic moves its
  description to the generic; making a unit single again keeps its own description.
- What is out lists events by end date, latest first, instead of by name.
- Group headings in the desk tables are larger, with a heavier rule.
- Links lose their underline. Links inside running text keep it.
- Events lists past events with gear still out in their own fold, above Past. Each event says how much is out under it,
  and an upcoming one how much of its gear is at someone's home.
- On an event's page, Not returned starts ticked and Not packed starts unticked. Each keeps its own setting when
  switching between Packing and Returning. Returning always offers Not returned, which keeps items out under another
  event, with It's with us. An event with no gear listed offers no filter.

## Chores

- Lint cleanups from Oxlint; no change in behaviour.
- Scroll restore keeps its target and its stop together; no change in behaviour.
