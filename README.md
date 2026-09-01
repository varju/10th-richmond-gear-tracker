# Gear Tracker

Gear inventory for a Scout group. Tracks what we own, where it lives, who has it, and what needs fixing.

It works with no signal. Gear lives in lockers and an outdoor yard where phones have none, so the app holds a full copy
on the device and syncs when a connection comes back.

## Status

Early build. The requirements are settled and the scanner is proven; the application is not written yet. See
[docs/tasks.md](docs/tasks.md) for what is being built and in what order.

## Documentation

| File                                                                                                 | What it holds                     |
| ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| [docs/architecture.md](docs/architecture.md)                                                         | How it is built, and why          |
| [docs/requirements/](docs/requirements/README.md)                                                    | Context, people, scale, locations |
| [docs/requirements/functional-requirements.md](docs/requirements/functional-requirements.md)         | What it must do (FR-\*)           |
| [docs/requirements/non-functional-requirements.md](docs/requirements/non-functional-requirements.md) | How well (NFR-\*)                 |
| [docs/stories/](docs/stories/README.md)                                                              | What a Friday evening looks like  |
| [docs/tasks.md](docs/tasks.md)                                                                       | The build, in order               |

## Getting started

Needs Python 3.11 or newer. One command sets up everything else, including `uv` if you do not have it:

```sh
./bin/setup
```

Then:

```sh
make test      # run the tests
make lint      # format and lint
make migrate   # bring a database up to date (DB=path/to.db)
```

## Running your own copy

Not yet. The deployment path is written down in [docs/architecture.md](docs/architecture.md#server) but there is nothing
to deploy so far.

## Licence

MIT. See [LICENSE](LICENSE).
