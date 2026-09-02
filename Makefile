DB ?= gear.db

.PHONY: setup test lint fmt migrate audit check client-install client-test client-build e2e serve image deploy logs

setup:
	./bin/setup

test:
	uv run pytest

lint:
	uv run ruff check .
	uv run ruff format --check .
	cd client && npm run lint

fmt:
	uv run ruff check --fix .
	uv run ruff format .

migrate:
	uv run gear-migrate --db $(DB)

audit:
	uv run pip-audit
	cd client && npm audit --omit=dev

client-install:
	cd client && npm ci

client-test:
	cd client && npm test

client-build:
	cd client && npm run build

# Browser tests: a real server, a real browser, the built client. Seconds, not milliseconds.
e2e: client-build
	cd client && npm run e2e

# The API with the built client in front of it, as deployed.
serve: client-build
	uv run gear-serve --db $(DB) --static client/dist

check: lint test client-test

# --- deployment ------------------------------------------------------------
# DOCKER_HOST points at the server, so these build and run there. The image is
# then native to that machine and never crosses architectures. See docs/deploy.md.

IMAGE ?= gear-tracker
TAG   ?= $(shell git describe --tags --always --dirty)
# The path the app is served from. Baked into the client at build time.
GEAR_BASE ?= /
# What starts the container once the image is built. The default is the compose
# file beside this one, for a box of its own. A host that runs the app next to
# other things sets this in .envrc, so nothing about that host is committed.
GEAR_DEPLOY ?= docker compose --project-name gear-tracker up --detach
GEAR_LOGS   ?= docker compose --project-name gear-tracker logs --follow --tail 50

image:
	docker build --build-arg BASE_PATH=$(GEAR_BASE) --tag $(IMAGE):$(TAG) --tag $(IMAGE):latest .
	@echo "built $(IMAGE):$(TAG), serving from $(GEAR_BASE)"

deploy: image
	GEAR_TAG=$(TAG) $(GEAR_DEPLOY)

logs:
	$(GEAR_LOGS)
