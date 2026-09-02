#!/bin/sh
# A real server for the browser tests: fresh database, one Admin, the demo
# inventory, the built client. The specs share it, and it starts from the same
# file a fresh instance does (NFR-MAINT-10).
set -eu
cd "$(dirname "$0")/.."
DB="${E2E_DB:-$(mktemp -d)/e2e.db}"
PORT="${E2E_PORT:-8765}"
uv run --project .. gear-migrate --db "$DB" >/dev/null
printf 'correct horse' | uv run --project .. gear-admin --db "$DB" create-admin --name Alice --email alice@example.org --password-stdin >/dev/null
uv run --project .. gear-admin --db "$DB" load --file demo >/dev/null
exec uv run --project .. gear-serve --db "$DB" --static dist --port "$PORT"
