# Gear Tracker requirements

Requirements for a gear inventory system for a single Scout group.

## Why we are building this

The group tracks gear on paper and in a spreadsheet. Nobody reliably knows what
is out and who has it. We reviewed the commercial options and found them
workable but priced per group per year, and all of them assume a live internet
connection.

Connectivity is the deciding constraint. Our gear is stored in lockers and an
outdoor yard where mobile data and WiFi are unreliable. A tool that stops
working at the locker door will not get used.

## Documents

| Document | Purpose |
|---|---|
| [functional-requirements.md](functional-requirements.md) | What the system must do |
| [non-functional-requirements.md](non-functional-requirements.md) | How well it must do it |
| [open-questions.md](open-questions.md) | Decisions needed before design |

## People

| Role | Who | What they do |
|---|---|---|
| Quartermaster | 1-2 people | Owns the inventory. Adds gear, prints labels, runs reports, closes repair tickets. |
| Scouter | 5-15 people | Takes gear out for camps and brings it back. Reports damage. |
| Youth / parent / public | Anyone | Scans a label on found gear and reports it. No account. |

## Where the gear lives

| Location | Notes |
|---|---|
| Cold locker | Unheated. Below freezing in winter. |
| Warm locker | Heated. |
| Garry Point yard | Outdoors. Weather exposed. |

These are the three storage locations in use today (FR-SET-03). Two of them rule
out leaving a tablet on site year-round: batteries and screens fail in the cold,
and nothing survives outdoors. See [Q3](open-questions.md).

## Scale

Planning numbers, not limits:

- 200-500 gear items
- 15 user accounts
- 10-20 camps or events per year
- Peak load: one Friday evening, 3-4 people checking out 50 items in 30 minutes

## Priorities

Requirements use MoSCoW: **Must**, **Should**, **Could**, **Won't** (this release).

## Reading the IDs

`FR-<area>-<number>` for functional, `NFR-<area>-<number>` for non-functional.
IDs are stable. If a requirement is dropped, mark it withdrawn rather than
reusing the number.
