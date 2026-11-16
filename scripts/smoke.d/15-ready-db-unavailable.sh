# shellcheck shell=bash
# Sourced by scripts/smoke.sh. Read-only. Proves that readiness really queries the database:
# an instance whose DATABASE_URL names a database that does not exist must answer /ready with
# 503 while staying alive. (The instance under test proves the 200 side in 10-health.sh.)
#
#   SMOKE_DBDOWN_URL    base URL of an instance started with an unusable DATABASE_URL (required)
#   SMOKE_SKIP_DBDOWN   set to 1 to skip this file explicitly (e.g. against a deployed API)
#
# Sends 1 counted request to SMOKE_DBDOWN_URL, none to SMOKE_BASE_URL.

if [ "${SMOKE_SKIP_DBDOWN:-0}" = "1" ]; then
  echo "  SKIPPED - database-unavailable check disabled by SMOKE_SKIP_DBDOWN=1"
else
  [ -n "${SMOKE_DBDOWN_URL:-}" ] ||
    fail "SMOKE_DBDOWN_URL is not set (start an instance with an unusable DATABASE_URL, or set SMOKE_SKIP_DBDOWN=1)"

  dbdown_url="${SMOKE_DBDOWN_URL%/}"

  deadline=$((SECONDS + SMOKE_WAIT_SECONDS))
  until curl -sS --max-time 2 -o /dev/null "$dbdown_url/health" 2>/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || fail "API not reachable at $dbdown_url after ${SMOKE_WAIT_SECONDS}s"
    sleep 1
  done

  http "$dbdown_url/ready"
  expect_status 503
  expect_problem
  expect_body '"code":"NOT_READY"'
  expect_body '"database":"unavailable"'
  pass "GET /ready is 503 application/problem+json when the database cannot be queried"

  http "$dbdown_url/health"
  expect_status 200
  pass "liveness stays 200 while the database is unavailable"
fi
