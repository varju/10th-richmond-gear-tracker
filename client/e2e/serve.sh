#!/bin/sh
# A real server for the browser tests: fresh database, one Admin, the built client.
set -eu
cd "$(dirname "$0")/.."
DB="${E2E_DB:-$(mktemp -d)/e2e.db}"
PORT="${E2E_PORT:-8765}"
uv run --project .. gear-migrate --db "$DB" >/dev/null
printf 'correct horse' | uv run --project .. gear-admin --db "$DB" create-admin --name Alice --email alice@example.org --password-stdin >/dev/null
exec uv run --project .. gear-serve --db "$DB" --static dist --port "$PORT"
