# Gear Tracker requirements

Gear inventory for a single Scout group.

## Why build it

Gear is tracked on paper and in a spreadsheet. Nobody knows what is out and who has it.

Commercial options work but assume a live internet connection. Our lockers and yard have unreliable signal. A tool that
dies at the locker door will not get used.

## Documents

| Document                                                         | Purpose         |
| ---------------------------------------------------------------- | --------------- |
| [functional-requirements.md](functional-requirements.md)         | What it must do |
| [non-functional-requirements.md](non-functional-requirements.md) | How well        |

## People

| Role          | Count | Does                                                                        |
| ------------- | ----- | --------------------------------------------------------------------------- |
| Quartermaster | 1-2   | Owns the inventory. Adds gear, prints labels, runs reports, closes tickets. |
| Scouter       | 5-15  | Takes gear out, brings it back, reports damage.                             |
| Public        | Any   | Scans found gear and reports it. No account.                                |

Quartermaster and Scouter are what the group calls people. The system has two roles (FR-USR-02): a Quartermaster holds
**Admin**, a Scouter holds **User**.

## Where gear lives

| Location         | Notes                               |
| ---------------- | ----------------------------------- |
| Cold locker      | Unheated. Below freezing in winter. |
| Warm locker      | Heated.                             |
| Garry Point yard | Outdoors. Holds trailers.           |

Each splits into numbered shelves or a specific trailer. Every item has a **home**: location plus sub-location, e.g.
"Warm locker / shelf 4" (FR-SET-03). Telling Scouters where gear goes back is where inventories usually break down.

Two of the three locations are too cold or too wet for a tablet left on site, so we use personal phones only.

## Scale

Planning numbers, not limits.

- 200-500 items
- 15 accounts
- 10-20 events per year
- Peak: 3-4 people checking out 50 items in 30 minutes on a Friday evening

## Conventions

Priorities are MoSCoW: **Must**, **Should**, **Could**, **Won't** (this release).

IDs are `FR-<area>-<nn>` and `NFR-<area>-<nn>`, and are stable. Mark dropped requirements withdrawn. Never reuse a
number.
