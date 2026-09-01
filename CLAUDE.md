# Gear Tracker

Gear inventory system for a Scout group. Tracks what gear we own, where it is,
who has it, and what needs fixing.

**Status: requirements only.** No code yet. See `docs/requirements/`.

## Read first

| File | What it holds |
|---|---|
| `docs/requirements/README.md` | Context, people, scale, storage locations |
| `docs/requirements/functional-requirements.md` | What the system must do (FR-*) |
| `docs/requirements/non-functional-requirements.md` | How well it must do it (NFR-*) |
| `docs/requirements/open-questions.md` | Decisions still open |

## Constraints that shape every decision

**Offline first.** Gear lives in lockers and an outdoor yard with unreliable
signal. Core flows — search, check-out, check-in — must work with no network.
Do not propose designs that assume a live server during use.

**Volunteers maintain this.** Boring, widely known technology beats clever
technology. Whoever inherits the code in three years will not be the person who
wrote it.

**Speed beats features.** The system competes with walking into a locker and
taking a tent. If it is slower than that, people take the tent and the data is
wrong.

**Event log, not status field.** Gear movements are append-only events. Current
status is derived. This is what makes offline merges safe (NFR-DATA-02).

## Writing requirements

- IDs are `FR-<area>-<nn>` and `NFR-<area>-<nn>`, and are stable. Never reuse a
  number. Mark dropped requirements withdrawn instead of deleting them.
- Priorities are MoSCoW: Must, Should, Could, Won't.
- One requirement per row. Testable. No compound "and also" requirements.

## House style

- ISO 24495-1 plain language. Short sentences, active voice, common words.
- Brevity is a virtue. Cut the sentence that adds nothing.
- This will be open sourced. Do not name commercial competitors anywhere in the
  repo. Describe what we need, not what someone else sells.
- No personal contact details, no youth names, no member data in the repo.

## Git

- Never `--no-verify`, never `commit --amend`, never `reset --hard`.
- Prefer `git grep` and `git ls-files` over `find`.
- Pull requests are created as drafts.
