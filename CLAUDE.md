# Gear Tracker

Gear inventory for a Scout group. Tracks what we own, where it lives, who has it, and what needs fixing.

**Status: early build.** Requirements are settled and the scanner is proven. The application is not written yet; see
`docs/tasks.md` for what is next.

## Read first

| File                                               | What it holds                     |
| -------------------------------------------------- | --------------------------------- |
| `docs/architecture.md`                             | How it is built, and why          |
| `docs/tasks.md`                                    | The build, in order               |
| `docs/deploy.md`                                   | Running your own copy             |
| `docs/stories/README.md`                           | What a Friday evening looks like  |
| `docs/requirements/README.md`                      | Context, people, scale, locations |
| `docs/requirements/functional-requirements.md`     | What the system must do (FR-\*)   |
| `docs/requirements/non-functional-requirements.md` | How well it must do it (NFR-\*)   |

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

- Each section is sorted by descending priority: Must, Should, Could, Won't. IDs run linearly from 01 within a section.
- IDs are stable from the September 2026 renumber onward. Never reuse a number. A dropped requirement stays in place,
  moves to Won't, and says what replaced it.
- A new requirement goes at the end of its priority band and takes the next free number. Do not renumber to keep the
  sort perfect; resort only when asked.
- Priorities are MoSCoW: Must, Should, Could, Won't.
- One requirement per row. Testable. No compound "and also".
- No trailing rationale. Explain why only when the reason constrains the build or stops a withdrawn idea coming back.

## Tasks

`docs/tasks.md` is a shrinking list, not a changelog. Delete a task when its work is committed. Git is the record of
what was done.

## Testing

Real dependencies, no mocks. Database code runs against real SQLite — a migrated file per test, never `:memory:`,
because in-memory databases ignore the WAL setting we ship. Pure logic is tested without a database. Client tests run
against a real IndexedDB implementation and a fake `fetch`; browser tests (`make e2e`) run the built client against the
real server. See [architecture.md](docs/architecture.md#testing) for the layers and what each costs.

Replay exists in Python and TypeScript. A change to either means changing `vectors/replay/` too.

## Formatting

Pre-configured hooks format files automatically on write. Do not hand-align markdown tables, wrap lines to a column, or
otherwise tidy whitespace — the hooks do it. Never reformat a file just to fix layout.

This covers layout only. The House style rules above are about what you write, and still apply.

## Git

- Never `--no-verify`, never `commit --amend`, never `reset --hard`.
- Prefer `git grep` and `git ls-files` over `find`.
- Pull requests are created as drafts.

## Delegating

Every edit goes to the `implementer` agent, with one exception: a few lines in one file. A change that touches two files
is delegated, however small each piece is. "The spec would take longer than the edit" is not a reason to do it here.

The top-level session keeps the parts that need this conversation: reading code, deciding the design, writing the spec,
reviewing what comes back, and the commit.

Agents defined in `.claude/agents/` pin their own model. For anything spawned without one, pick the smallest model that
will do. Never Fable.
