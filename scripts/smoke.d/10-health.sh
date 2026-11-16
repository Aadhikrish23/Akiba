# shellcheck shell=bash
# Sourced by scripts/smoke.sh. Read-only. Requests against SMOKE_BASE_URL that count towards the
# global rate limit: 3 (/health is exempt).
#
#   SMOKE_EXPECT_DB   expected `checks.database` from /ready: ok | not_configured (default: either).
#                     "ok" means the API ran `SELECT 1` against its database.

http "$SMOKE_BASE_URL/health"
expect_status 200
expect_body '"status":"ok"'
expect_header x-request-id '^[A-Za-z0-9._:-]+$'
expect_header x-content-type-options '^nosniff$'
expect_header content-security-policy "default-src 'none'"
expect_no_header x-powered-by
pass "GET /health is 200 with security headers and a request ID"

http -H 'X-Request-Id: smoke-req-1' "$SMOKE_BASE_URL/ready"
expect_status 200
expect_body '"status":"ready"'
expect_header x-request-id '^smoke-req-1$'
case "${SMOKE_EXPECT_DB:-}" in
  '') ;;
  ok | not_configured) expect_body "\"database\":\"$SMOKE_EXPECT_DB\"" ;;
  *) fail "SMOKE_EXPECT_DB must be ok or not_configured" ;;
esac
pass "GET /ready is 200 (database: ${SMOKE_EXPECT_DB:-not asserted}) and echoes X-Request-Id"

http "$SMOKE_BASE_URL/v1/smoke-no-such-route"
expect_status 404
expect_problem
expect_body '"code":"NOT_FOUND"'
expect_body '"status":404'
pass "unknown route is 404 application/problem+json"

http -H 'Origin: https://smoke-not-allowed.invalid' "$SMOKE_BASE_URL/v1/smoke-no-such-route"
expect_status 404
expect_no_header access-control-allow-origin
expect_no_header access-control-allow-credentials
pass "an unlisted Origin receives no CORS headers"
