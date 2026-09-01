# Gear Tracker

Gear inventory for a Scout group. Tracks what we own, where it lives, who has it, and what needs fixing.

**Status: requirements only.** No code yet. See `docs/requirements/`.

## Read first

| File                                               | What it holds                     |
| -------------------------------------------------- | --------------------------------- |
| `docs/requirements/README.md`                      | Context, people, scale, locations |
| `docs/requirements/functional-requirements.md`     | What the system must do (FR-*)    |
| `docs/requirements/non-functional-requirements.md` | How well it must do it (NFR-*)    |
| `docs/requirements/open-questions.md`              | Decisions still open              |

## Constraints that shape every decision

**Offline first.** Gear lives in lockers and an outdoor yard with poor signal. Search, check-out, and check-in must work
with no network. Never propose a design that assumes a live server during use.

**Volunteers maintain this.** Boring, widely known technology. Whoever inherits the code in three years did not write
it.

**Speed beats features.** This competes with walking into a locker and taking a tent. Slower than that, and people take
the tent and the data goes wrong.

**Event log, not status field.** Movements are append-only; status is derived. That is what makes offline merges safe
(NFR-DATA-02).

## Writing requirements

- IDs are `FR-<area>-<nn>` and `NFR-<area>-<nn>`, and are stable. Never reuse a number. Mark dropped requirements
  withdrawn.
- Priorities are MoSCoW: Must, Should, Could, Won't.
- One requirement per row. Testable. No compound "and also".

## House style

- As terse as possible while still making the point. Cut every sentence that adds nothing.
- ISO 24495-1 plain language. Short sentences, active voice, common words.
- This will be open sourced. Never name commercial competitors in the repo. Describe what we need, not what someone else
  sells.
- No contact details, youth names, or member data in the repo.

## Git

- Never `--no-verify`, never `commit --amend`, never `reset --hard`.
- Prefer `git grep` and `git ls-files` over `find`.
- Pull requests are created as drafts.
