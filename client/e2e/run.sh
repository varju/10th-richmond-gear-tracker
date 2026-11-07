#!/bin/bash
# No arguments: the three projects at once, each on its own port and database. Any arguments: one plain `playwright test`.
set -u
cd "$(dirname "$0")/.."
if [ $# -gt 0 ]; then
  exec npx playwright test "$@"
fi

base="${E2E_PORT:-8765}"
projects=(phone iphone desk)
logs="$(mktemp -d)"
pids=()

cleanup() {
  trap - INT TERM EXIT
  for pid in ${pids[@]+"${pids[@]}"}; do
    kill -INT -- "-$pid" 2>/dev/null
  done
  wait 2>/dev/null
  rm -rf "$logs"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

set -m
for i in "${!projects[@]}"; do
  name="${projects[$i]}"
  E2E_PORT=$((base + i)) npx playwright test --project="$name" --output="test-results/$name" >"$logs/$name.log" 2>&1 &
  pids+=($!)
done
set +m

status=0
for i in "${!pids[@]}"; do
  wait "${pids[$i]}" || status=1
done
for name in "${projects[@]}"; do
  echo "== $name =="
  cat "$logs/$name.log"
done
exit "$status"
