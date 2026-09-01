DB ?= gear.db

.PHONY: setup test lint fmt migrate audit check

setup:
	./bin/setup

test:
	uv run pytest

lint:
	uv run ruff check .
	uv run ruff format --check .

fmt:
	uv run ruff check --fix .
	uv run ruff format .

migrate:
	uv run gear-migrate --db $(DB)

audit:
	uv run pip-audit

check: lint test
