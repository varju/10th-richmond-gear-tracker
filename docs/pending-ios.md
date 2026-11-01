# Pending iOS release

App changes since `ios-1.0.2-333` that reach iPhones only through the next release.

## Functional

What the app does differently.

- A unit can no longer be added, moved or grouped under a pool, a retired generic or one folded away, and retired gear
  can no longer be moved or grouped.
- Back and forward return a screen to where it was scrolled, and a new screen opens at its top.
- Edit can turn a single item into a counted stack; the item page no longer has its own button for it.
- The wide inventory table has tighter rows and hides a generic's units until its count is clicked or a search or filter
  is on. A generic shows its units' Repair and Missing flags.
- Checking out a counted stack offers an All button that takes everything that is in.
- Reservations are now called events throughout the app and its guide, at `/events` URLs. In **Events**, **Out with no
  reservation** is now **Out, not planned**, and its **Reserve** button is **Add**. The audit log's **Event** filter is
  now **What happened**.
- Counted stacks now show under their event: **Events** lists an event with only counted gear out, **Add** brings that
  gear in, and **What is out** shows a stack's count per event.

## Chores

- The home page says "All clear." when nothing needs attention, not "Nothing needs you."
- React 19.3.1 and zxing-wasm 3.1.6.
