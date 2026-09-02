# Stories

What people actually do with Gear Tracker, in the order they do it. Requirements say what the system must do; stories
say what a Friday evening looks like.

## Documents

| Story set                          | Covers                                               |
| ---------------------------------- | ---------------------------------------------------- |
| [bootstrap.md](bootstrap.md)       | Getting 400 items into the system for the first time |
| [movement.md](movement.md)         | Check-out and check-in. The core loop                |
| [reservations.md](reservations.md) | Planning a camp and packing for it                   |
| [repairs.md](repairs.md)           | Reporting and fixing broken gear                     |
| [public.md](public.md)             | Someone finds our gear and has no account            |
| [admin.md](admin.md)               | Users, roles, and the audit trail                    |
| [reports.md](reports.md)           | Answering "where is everything?"                     |
| [offline.md](offline.md)           | What happens with no signal                          |
| [assistant.md](assistant.md)       | Talking to the inventory through an MCP client       |

## Format

IDs are `S-<area>-<nn>` and are stable. Each story names the requirements it covers, so a change to a story shows which
requirements move with it.

Stories are written from the actor's point of view, in the present tense, describing what happens rather than what the
screen looks like.

## Actors

- **Quartermaster** — owns the inventory. One or two people.
- **Scouter** — takes gear out and brings it back. Five to fifteen people.
- **Finder** — someone outside the group who has found our gear. No account.
