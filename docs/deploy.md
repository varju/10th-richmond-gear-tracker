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

`GEAR_DATA` is a directory on the server. The container writes `gear.db` into it, and nothing else goes there, so a
backup is a copy of that directory (NFR-DATA-05, NFR-DATA-06) and moving house is a copy of it to the next machine
(NFR-MAINT-05).

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

Made at the keyboard, once (FR-USR-13):

```sh
docker exec -it gear-tracker gear-admin --db /data/gear.db \
  create-admin --name "Your Name" --email you@example.com --password-stdin
```

If every Admin later loses their password, the way back in is the same keyboard:

```sh
docker exec -it gear-tracker gear-admin --db /data/gear.db reset-link --email you@example.com
```

## Still to do before real use

The container answers on your network. Going live needs three more things, all outside this file:

- HTTPS, and a way in from the internet that does not forward a port into the house (NFR-DEP-05, NFR-SEC-01).
- The group's own domain pointed at it, because that hostname is printed on 400 stickers (NFR-DEP-09).
- A nightly copy of `GEAR_DATA` to somewhere off the machine, and a restore tested and written down (NFR-DATA-07).

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
export GEAR_LOGS="docker logs --follow --tail 50 theirs_gear_1"
```

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
