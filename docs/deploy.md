# Deploying

One container: the API, the built client, and a SQLite file on the host. No database server, no registry, no CI
pipeline. A volunteer can do this in an evening (NFR-DEP-07).

## What you need

- A machine at home running Docker, reachable on your network (NFR-DEP-03, NFR-DEP-04).
- A checkout of this repository on your laptop. Docker builds on the server, so the laptop needs nothing but the client.

## Point Docker at the server

Everything below runs against a remote Docker daemon, set by environment variables. Put them in `.envrc`, which is not
committed:

```sh
export DOCKER_HOST=tcp://your-server:2376
export DOCKER_TLS=1
export DOCKER_CERT_PATH=/path/to/client/certificates

# Where the server keeps the database, and the port it answers on.
export GEAR_DATA=/share/Docker/gear-tracker
export GEAR_PORT=8000

# The path it is served from. A domain root unless it sits under another site.
export GEAR_BASE=/
```

`GEAR_DATA` is a directory on the server. Everything worth keeping is in it — `gear.db`, the photos under `photos/`, the
nightly snapshots under `backups/`, and the `seed.toml` below — so moving house is a copy of that one directory to the
next machine (NFR-MAINT-05).

Check the connection before going further:

```sh
docker info
```

## Build and run

```sh
make deploy
```

That builds the image and starts the container. Both happen on the server: the build runs there, so the image is native
to that machine and never has to cross architectures from a laptop. A cold build takes about two minutes; after that
only what changed rebuilds.

Migrations run on start, so a deploy is one step and a restart is safe (NFR-MAINT-07).

```sh
make logs    # follow the container's output
```

## Under a path on an existing site

The app can live at `https://example.org/gear` rather than on a host of its own. Two things have to agree.

**Build it with the path.** It is baked into every asset URL, so it is a build argument, not a runtime setting:

```sh
make image GEAR_BASE=/gear/
```

**Strip the path at the proxy.** The app still serves itself from a root, so nginx takes `/gear` off before the request
arrives:

```nginx
location /gear/ {
  rewrite    ^/gear/(.*)$ /$1 break;
  proxy_pass http://gear:8000;
  # Photos are uploaded whole. The app refuses anything over 5 MB; the proxy must not refuse first.
  client_max_body_size 6m;
}
location = /gear {
  return 301 https://$host/gear/;
}
```

The rewrite does the stripping, not a trailing slash on `proxy_pass`. Once `proxy_pass` holds a variable, nginx passes
the whole original URI and ignores a URI part on the directive. Get that wrong and every asset and API call is answered
with `index.html` — a 200 that looks fine and works for nothing.

**Say what a CDN may keep.** Anything in front of the site caches by file extension unless told otherwise, and that rule
does not know an SPA from a static site. Vite fingerprints everything under `assets/`, so those may be kept for a year;
nothing else may be kept at all, because a stale `index.html` or service worker pins every phone to an old version of
the app.

```nginx
map $request_uri $gear_cache_control {
  default          "no-store";
  ~^/gear/assets/  "public, max-age=31536000, immutable";
}
```

`$request_uri`, not `$uri`: the rewrite above has already taken `/gear` off `$uri`.

One thing a path costs: a sticker's URL grows by its length, and QR module size shrinks to match
([architecture.md](architecture.md#keep-the-url-short)). If the stickers are printed against this hostname, give the
public code route its own top-level location rather than putting it under the app's path.

## The first Admin

`GEAR_DATA/seed.toml` holds it, along with the group setting and the mail account. Copy `seed.example.toml` from this
repository to the server and fill it in:

```toml
[admin]
name = "Your Name"
email = "you@example.com"
password = "at least eight characters"
```

The container reads the file after migrating, at every start (NFR-DEP-10), so a deploy is still one command. It is
idempotent: the Admin is created only if no account has that email, and the group and mail are written only where the
file differs from what is stored. The password is used once, at creation, so a password changed in the app stays
changed.

The file holds two passwords, so it lives beside the database rather than in the repository. Nothing serves it.

`inventory = "demo"` at the top of the file fills an empty database with three lockers and some gear, so there is
something to look at before the real inventory exists. It loads only while the database has no items, so it happens once
and never again (NFR-MAINT-10). `gear-admin load --file demo` does the same thing by hand.

Without a seed file, the same account is made at the keyboard (FR-USR-13):

```sh
docker exec -it gear-tracker gear-admin --db /data/gear.db \
  create-admin --name "Your Name" --email you@example.com --password-stdin
```

If every Admin later loses their password, the way back in is the keyboard either way:

```sh
docker exec -it gear-tracker gear-admin --db /data/gear.db reset-link --email you@example.com
```

## Sending mail

Optional. Fill nothing in and the app shows every invite and reset link for an Admin to copy, which costs nothing to run
(FR-USR-12).

To have the server send them instead, sign in as an Admin and open **Settings › Mail** (FR-USR-15), or fill the `[mail]`
section of the seed file in. One mailbox at the provider the group already uses is enough. Most providers want an app
password here rather than the password used to read mail, and Gmail requires one.

| Field      | Gmail            |
| ---------- | ---------------- |
| Server     | smtp.gmail.com   |
| Port       | 465              |
| Encryption | SSL              |
| Username   | the full address |
| Password   | an app password  |
| Send from  | the same address |

**Send a test** posts a message to your own address, so a wrong password turns up now rather than at someone else's
password reset (FR-USR-16). The password is kept on the server and never sent back to a device (NFR-SEC-10); saving with
the password box empty keeps the one already stored.

## Backups

`cp gear.db` is not a backup. In WAL mode the file on disk is half the story until a checkpoint lands, and a copy taken
mid-write restores as a corrupt database. `gear-backup` uses SQLite's online backup API instead, so the server keeps
serving while the snapshot is taken:

```sh
docker exec gear-tracker gear-backup --db /data/gear.db --into /data/backups
```

That writes one dated, gzipped file that restores on its own, deletes snapshots older than 30 days (NFR-DATA-05), and
runs SQLite's integrity check on what it wrote. The check is the part a file copy cannot give you: a nightly answer to
whether the database is still sound, rather than finding out at a restore.

Nightly, from the host's own cron:

```
0 3 * * * docker exec gear-tracker gear-backup --db /data/gear.db --into /data/backups
```

It prints the file it wrote, and on a bad database prints one line to stderr and exits 1, so cron mails something worth
reading.

**Off the machine.** `GEAR_DATA` sits on a filesystem that snapshots hourly and is copied off-site every two weeks, so
each nightly file rides along with no second tool (NFR-DATA-06). Worth knowing what that buys: the hourly snapshots
cover everything short of losing the machine, and losing the machine outright could cost up to two weeks. If that stops
being acceptable, the fix is a nightly push of `GEAR_DATA/backups` somewhere else, not a change to any of this.

## Restoring

Rehearse it once before real use, not on the day you need it (NFR-DATA-07).

```sh
docker stop gear-tracker
cd "$GEAR_DATA"

# The -wal and -shm files belong to the database you are replacing. Leave one
# behind and SQLite trusts it over the file you just restored.
mv gear.db gear.db.before-restore
rm -f gear.db-wal gear.db-shm
gunzip --stdout backups/gear-2026-09-01.db.gz > gear.db

docker start gear-tracker
docker exec gear-tracker python -c \
  "import sqlite3; print(sqlite3.connect('/data/gear.db').execute('PRAGMA integrity_check').fetchone()[0])"
```

That last line prints `ok`. Then sign in and look for something recent.

Photos are not in the snapshot. They are the files under `photos/`, and they are only ever added, so the ones on disk
are the ones the restored database names, plus any uploaded after the snapshot. Nothing to do; leave the directory
alone.

Keep `gear.db.before-restore` until you are sure. Nothing else has to be told: phones whose cursor is now ahead of the
log are asked to bootstrap again, and they do it at their next sync.

What a restore costs is everything recorded between the snapshot and the failure. Phones re-send what they never managed
to send, but not what the server had already accepted and then lost.

## Start over

Practice data is worth throwing away before real use, and M8 resets the deployed database anyway.

```sh
make start-over
```

That stops the container, moves `gear.db`, its `-wal` and `-shm` files, and `photos/` into `GEAR_DATA/old-<timestamp>/`,
and starts again on an empty database. The seed file is read on the way up, so the group comes back with its Admin, its
settings, and nothing else.

Nothing is deleted. Delete the `old-*` directory by hand once you are sure, or keep it: it is a database that opens.

It needs `GEAR_DATA`, and `GEAR_STOP` if the host runs the app beside other things. The move itself runs in a throwaway
container mounting `GEAR_DATA`, because the directory is on the server rather than on your laptop.

## Moving house

The server is one container and one directory, so moving it to another machine or another volunteer is a copy and a DNS
change (NFR-MAINT-05).

1. On the old machine, take a snapshot with `gear-backup` as above, then `docker stop gear-tracker` so nothing is
   mid-write.
2. Copy `GEAR_DATA` to the new machine, `photos/` included. Install Docker there if it is not already running.
3. On your laptop, point `.envrc` at the new host: `DOCKER_HOST`, the certificates, `GEAR_DATA`, `GEAR_PORT`,
   `GEAR_BASE`, and `GEAR_DEPLOY` if the host runs the app beside other things.
4. `make deploy`. Migrations run on start, so a newer image against an older file needs no extra step.
5. Repoint the domain at the new machine.

The stickers do not change, and nothing on a phone changes. The QR codes carry the group's domain rather than the
server's address, which is what makes this a DNS change rather than a reprint of 400 labels (FR-TAG-13, NFR-DEP-09).

Sessions survive: they live in the database you carried over, so nobody signs in again.

## How the image is put together

Three stages, so the running image carries none of the build:

1. Node builds the client. Only `dist/` leaves the stage.
2. `uv sync --locked` builds a virtual environment from `uv.lock`. Nothing is compiled; the dependencies ship as wheels.
3. The runtime stage is `python:3.14-slim` plus that environment, the source, the migrations, and the built client.
   About 180 MB.

The container holds no state. Delete it, run `make deploy` again, and the database it reopens is the one under
`GEAR_DATA`.

## Running it beside something else

A host may already run other containers, and want this one declared with them rather than in the `compose.yaml` here.
Set `GEAR_DEPLOY` to whatever starts it, and `make deploy` builds the image and then runs that instead:

```sh
export GEAR_DEPLOY="docker compose --project-name theirs --file /path/to/theirs.yaml up --detach --no-deps gear"
export GEAR_STOP="docker compose --project-name theirs --file /path/to/theirs.yaml stop gear"
export GEAR_LOGS="docker logs --follow --tail 50 theirs_gear_1"
```

`GEAR_STOP` is only used by `make start-over`.

Both live in `.envrc`, so a host's own layout stays out of this repository. `make deploy` is still one command.

## Knowing what is running

`make image` prints the tag it built and the path it built it for. Two things are worth reading there.

A tag ending in `-dirty` was built from a working tree with uncommitted changes: it matches no commit and cannot be
rebuilt. Commit before deploying anything that matters.

The path is baked into the client and the proxy in front has to agree with it. Nothing checks that, so the image records
it:

```sh
docker inspect --format '{{index .Config.Labels "gear.base-path"}}' gear-tracker:latest
```

Every build also leaves a tag named after its commit, so going back a version is a retag and a restart rather than a
rebuild:

```sh
docker tag gear-tracker:<commit> gear-tracker:latest
eval "$GEAR_DEPLOY"
```

Run the deploy command itself, not `make deploy`: that would build the image again and put the version you are backing
away from straight back onto `latest`.
