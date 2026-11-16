#!/usr/bin/env bash
# Smoke test for a RUNNING Akiba API. Sources every scripts/smoke.d/NN-name.sh in numeric order.
#
#   SMOKE_BASE_URL=http://127.0.0.1:3000 scripts/smoke.sh
#
# Safe against a real database in production mode: checks must be read-only or clean up after
# themselves. Each later task adds its own smoke.d file with a free number; checks that end a
# session (logout, token replay) belong in a 99- file so they run last.
#
# Environment:
#   SMOKE_BASE_URL       API under test (default http://127.0.0.1:3000)
#   SMOKE_WAIT_SECONDS   how long to wait for /health before giving up (default 30)
#   plus whatever the individual smoke.d files document.
#
# Conventions for smoke.d files (they run under `set -euo pipefail`):
#   - call `http <curl args>` and then assert with the expect_* helpers;
#   - never pipe a command straight into `grep -q`; capture output first, then test it;
#   - to assert that a command fails, write `! cmd || fail "..."`.

set -euo pipefail

SMOKE_BASE_URL="${SMOKE_BASE_URL:-http://127.0.0.1:3000}"
SMOKE_BASE_URL="${SMOKE_BASE_URL%/}"
SMOKE_WAIT_SECONDS="${SMOKE_WAIT_SECONDS:-30}"
SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke.d"

SMOKE_TMP="$(mktemp -d)"
trap 'rm -rf "$SMOKE_TMP"' EXIT

SMOKE_CHECKS=0
SMOKE_REQUESTS=0
SMOKE_STATUS=""
SMOKE_HEADERS=""
SMOKE_BODY=""

fail() {
  echo "SMOKE FAIL: $*" >&2
  if [ -n "$SMOKE_STATUS" ]; then
    echo "--- last response: HTTP $SMOKE_STATUS" >&2
    echo "$SMOKE_HEADERS" >&2
    echo "$SMOKE_BODY" >&2
  fi
  exit 1
}

pass() {
  SMOKE_CHECKS=$((SMOKE_CHECKS + 1))
  echo "  ok - $*"
}

# http <curl args...>: perform one request; sets SMOKE_STATUS, SMOKE_HEADERS and SMOKE_BODY.
http() {
  local status
  SMOKE_REQUESTS=$((SMOKE_REQUESTS + 1))
  status="$(curl -sS --max-time 10 -o "$SMOKE_TMP/body" -D "$SMOKE_TMP/headers" -w '%{http_code}' "$@")" ||
    fail "request failed: curl $*"
  SMOKE_STATUS="$status"
  SMOKE_HEADERS="$(tr -d '\r' <"$SMOKE_TMP/headers")"
  SMOKE_BODY="$(cat "$SMOKE_TMP/body")"
}

expect_status() {
  [ "$SMOKE_STATUS" = "$1" ] || fail "expected HTTP $1, got $SMOKE_STATUS"
}

# header_value <name>: print the value of a response header (empty if absent).
header_value() {
  local line
  line="$(grep -i "^$1:" <<<"$SMOKE_HEADERS" | head -n 1 || true)"
  line="${line#*:}"
  echo "${line# }"
}

# expect_header <name> <extended regex matched against the value>
expect_header() {
  local value
  value="$(header_value "$1")"
  [ -n "$value" ] || fail "missing response header $1"
  grep -Eqi -- "$2" <<<"$value" || fail "header $1 is '$value', expected to match '$2'"
}

expect_no_header() {
  local value
  value="$(header_value "$1")"
  [ -z "$value" ] || fail "unexpected response header $1: $value"
}

# expect_body <fixed string>
expect_body() {
  grep -Fq -- "$1" <<<"$SMOKE_BODY" || fail "response body does not contain: $1"
}

expect_problem() {
  expect_header content-type '^application/problem\+json'
  expect_body '"requestId":"'
}

echo "Smoke: $SMOKE_BASE_URL"

# Wait for liveness. /health is exempt from rate limiting, so polling it costs no budget.
deadline=$((SECONDS + SMOKE_WAIT_SECONDS))
until curl -sS --max-time 2 -o /dev/null "$SMOKE_BASE_URL/health" 2>/dev/null; do
  [ "$SECONDS" -lt "$deadline" ] || fail "API not reachable at $SMOKE_BASE_URL after ${SMOKE_WAIT_SECONDS}s"
  sleep 1
done

shopt -s nullglob
smoke_files=("$SMOKE_DIR"/[0-9][0-9]-*.sh)
shopt -u nullglob
[ "${#smoke_files[@]}" -gt 0 ] || fail "no smoke files found in $SMOKE_DIR"

for smoke_file in "${smoke_files[@]}"; do
  echo "== $(basename "$smoke_file")"
  # shellcheck source=/dev/null
  source "$smoke_file"
done

echo "Smoke passed: $SMOKE_CHECKS checks, $SMOKE_REQUESTS requests."
