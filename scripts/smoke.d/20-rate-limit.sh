# shellcheck shell=bash
# Sourced by scripts/smoke.sh. Read-only. Proves 429 + Retry-After (NFR-SEC-005) against a SECOND
# API instance started with a deliberately low API_RATE_LIMIT_MAX, so the instance under test
# keeps its normal budget and no default is weakened.
#
#   SMOKE_RATELIMIT_URL    base URL of the low-limit instance (required)
#   SMOKE_RATELIMIT_MAX    the API_RATE_LIMIT_MAX that instance was started with (required)
#   SMOKE_SKIP_RATELIMIT   set to 1 to skip this file explicitly (e.g. against a deployed API)
#
# Sends SMOKE_RATELIMIT_MAX + 1 requests to the low-limit instance, none to SMOKE_BASE_URL.

if [ "${SMOKE_SKIP_RATELIMIT:-0}" = "1" ]; then
  echo "  SKIPPED - rate-limit check disabled by SMOKE_SKIP_RATELIMIT=1"
else
  [ -n "${SMOKE_RATELIMIT_URL:-}" ] ||
    fail "SMOKE_RATELIMIT_URL is not set (start a low-limit instance, or set SMOKE_SKIP_RATELIMIT=1)"
  [[ "${SMOKE_RATELIMIT_MAX:-}" =~ ^[1-9][0-9]*$ ]] ||
    fail "SMOKE_RATELIMIT_MAX must be the positive integer limit of the low-limit instance"

  rate_url="${SMOKE_RATELIMIT_URL%/}/v1/smoke-rate-limit-probe"

  for ((attempt = 1; attempt <= SMOKE_RATELIMIT_MAX; attempt++)); do
    http "$rate_url"
    expect_status 404
  done
  expect_header ratelimit-remaining '^0$'
  pass "the first $SMOKE_RATELIMIT_MAX requests are within the limit"

  http "$rate_url"
  expect_status 429
  expect_problem
  expect_body '"code":"RATE_LIMITED"'
  expect_header retry-after '^[1-9][0-9]*$'
  pass "request $((SMOKE_RATELIMIT_MAX + 1)) is 429 application/problem+json with Retry-After"

  http "${SMOKE_RATELIMIT_URL%/}/health"
  expect_status 200
  pass "liveness stays 200 while the client is rate limited"
fi
