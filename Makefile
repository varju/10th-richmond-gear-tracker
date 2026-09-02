DB ?= gear.db

.PHONY: setup test lint fmt migrate audit check client-install client-test client-build e2e serve

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
