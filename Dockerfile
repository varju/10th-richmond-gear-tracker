# One image: the API with the built client in front of it, the same shape as
# `make serve`. The database is not in it; that lives on a volume.
#
# Build this on the Docker host, not on a laptop. See docs/deploy.md.

# The client. Node stays in this stage; only client/dist leaves it.
FROM node:26-slim AS client
# Where the app is served from, baked into every asset URL. "/" for a host of
# its own, "/gear/" when it sits under an existing site. Must end in a slash.
ARG BASE_PATH=/
ENV BASE_PATH=$BASE_PATH
# The commit this build is from. "dev" outside a `make image` build, which is
# what `npm run dev` shows too.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
# The gear-guide plugin reads this at build time, resolved from the client dir.
COPY docs/guide/ /docs/guide/
RUN npm run build

# The server's dependencies, from the lock file, into a venv copied whole below.
FROM python:3.14-slim AS server
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock README.md LICENSE ./
# Dependencies before source, so editing the source does not re-resolve them.
RUN uv sync --locked --no-dev --no-install-project
COPY src/ ./src/
RUN uv sync --locked --no-dev

FROM python:3.14-slim
ARG BASE_PATH=/
ARG GIT_SHA=dev
# Recorded so `docker inspect` can say what path a running image was built for.
# The proxy in front of it has to agree, and nothing else can check that.
LABEL gear.base-path=$BASE_PATH
LABEL gear.git-sha=$GIT_SHA
WORKDIR /app
COPY --from=server /app/.venv ./.venv
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY bin/docker-entrypoint ./bin/docker-entrypoint
COPY --from=client /client/dist ./client

# The container is disposable; everything worth keeping is one file under /data
# (NFR-DATA-06). DB is the same name the Makefile and the CLI use.
ENV PATH=/app/.venv/bin:$PATH \
    DB=/data/gear.db
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"

ENTRYPOINT ["/app/bin/docker-entrypoint"]
