# shellcheck shell=bash
# Sourced by scripts/smoke.sh. Email verification and password reset (T5), as far as they can be
# checked from outside in production mode: the API's email sender delivers nothing and (rightly)
# never writes a link to its log, so no smoke run can obtain a real token. This file therefore
# proves the two properties that hold without one:
#   - forgot-password ALWAYS answers 202 with the same body, for an address that has an account
#     and for one that does not (no user enumeration);
#   - a wrong one-time token gets the one generic 400 on both token endpoints.
# The full link flows (verify, reset, change, session revocation) are covered by the integration
# tests in apps/api/src/modules/auth/auth.email.test.ts.
#
# Runs against its OWN API instance, because 20-auth.sh uses 9 of the 10 requests per minute that
# the per-IP /v1/auth limit allows on the instance under test.
#
#   SMOKE_AUTH_EMAIL_URL   base URL of a second instance on the same database with the default
#                          auth limit (required)
#   SMOKE_SKIP_AUTH_EMAIL  set to 1 to skip this file explicitly
#
# WRITES DATA: registers one more throwaway account under @smoke.akiba.invalid and leaves it
# behind, with unused one-time tokens (they expire within a day) and one open session.
#
# Request budget against SMOKE_AUTH_EMAIL_URL: 9 requests to /v1/auth/* (limit 10 per minute per
# IP, so this file can run once per minute per client IP). None to SMOKE_BASE_URL.

if [ "${SMOKE_SKIP_AUTH_EMAIL:-0}" = "1" ]; then
  echo "  SKIPPED - auth email checks disabled by SMOKE_SKIP_AUTH_EMAIL=1"
else
  [ -n "${SMOKE_AUTH_EMAIL_URL:-}" ] ||
    fail "SMOKE_AUTH_EMAIL_URL is not set (start a second instance, or set SMOKE_SKIP_AUTH_EMAIL=1)"

  mail_url="${SMOKE_AUTH_EMAIL_URL%/}/v1/auth"
  mail_json=(-H 'Content-Type: application/json')
  mail_known="smoke-mail-$(date +%s)-$RANDOM$RANDOM@smoke.akiba.invalid"
  mail_unknown="smoke-nobody-$(date +%s)-$RANDOM$RANDOM@smoke.akiba.invalid"
  mail_password="smoke $(head -c 18 /dev/urandom | base64 | tr -d '/+=') pw"
  # Shaped like a real token (43 base64url characters), but never issued.
  mail_token="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
  accepted='{"status":"accepted"}'
  invalid_token='"code":"INVALID_TOKEN"'

  # without_request_id: the last body with the per-request ID removed, for comparing two bodies.
  without_request_id() {
    sed 's/"requestId":"[^"]*"//' <<<"$SMOKE_BODY"
  }

  # 1. An account to ask about.
  http -X POST "${mail_json[@]}" \
    -d "{\"email\":\"$mail_known\",\"password\":\"$mail_password\",\"displayName\":\"Smoke Mail\"}" \
    "$mail_url/register"
  expect_status 201
  pass "registered a throwaway account on the auth-email instance"

  # 2. Forgot password: 202 and the same body whether or not the address has an account.
  http -X POST "${mail_json[@]}" -d "{\"email\":\"$mail_known\"}" "$mail_url/password/forgot"
  expect_status 202
  [ "$SMOKE_BODY" = "$accepted" ] || fail "forgot (existing address) body is not exactly $accepted"
  expect_header cache-control '^no-store$'
  known_type="$(header_value content-type)"

  http -X POST "${mail_json[@]}" -d "{\"email\":\"$mail_unknown\"}" "$mail_url/password/forgot"
  expect_status 202
  [ "$SMOKE_BODY" = "$accepted" ] || fail "forgot (unknown address) body is not exactly $accepted"
  expect_header cache-control '^no-store$'
  [ "$(header_value content-type)" = "$known_type" ] ||
    fail "forgot answers with different content types for existing and unknown addresses"
  pass "POST /v1/auth/password/forgot is 202 with an identical body for an existing and an unknown address"

  # 3. Asking again changes nothing visible (the per-address email budget is silent).
  http -X POST "${mail_json[@]}" -d "{\"email\":\"$mail_known\"}" "$mail_url/password/forgot"
  expect_status 202
  [ "$SMOKE_BODY" = "$accepted" ] || fail "repeated forgot body is not exactly $accepted"
  pass "a repeated forgot request is 202 again"

  # 4. A malformed address is a validation error (nothing about accounts in it).
  http -X POST "${mail_json[@]}" -d '{"email":"not-an-email"}' "$mail_url/password/forgot"
  expect_status 422
  expect_problem
  expect_body '"code":"VALIDATION_ERROR"'
  pass "forgot with an invalid email is 422"

  # 5. A token that was never issued: the generic 400 on reset...
  http -X POST "${mail_json[@]}" \
    -d "{\"token\":\"$mail_token\",\"newPassword\":\"$mail_password 2\"}" "$mail_url/password/reset"
  expect_status 400
  expect_problem
  expect_body "$invalid_token"
  reset_problem="$(without_request_id)"
  pass "POST /v1/auth/password/reset with an unknown token is the generic 400"

  # ...and the very same problem for a token of the wrong shape, and on verify-email.
  http -X POST "${mail_json[@]}" \
    -d "{\"token\":\"not-a-token\",\"newPassword\":\"$mail_password 2\"}" "$mail_url/password/reset"
  expect_status 400
  [ "$(without_request_id)" = "$reset_problem" ] ||
    fail "reset answers differently for a malformed token than for an unknown one"
  http -X POST "${mail_json[@]}" -d "{\"token\":\"$mail_token\"}" "$mail_url/verify-email"
  expect_status 400
  expect_problem
  [ "$(without_request_id)" = "$reset_problem" ] ||
    fail "verify-email answers differently from reset for an unknown token"
  pass "malformed tokens and POST /v1/auth/verify-email get the identical generic 400"

  # 6. The failed reset changed nothing: the original password still signs in.
  http -X POST "${mail_json[@]}" -H 'X-Client: mobile/smoke' \
    -d "{\"email\":\"$mail_known\",\"password\":\"$mail_password\"}" "$mail_url/login"
  expect_status 200
  expect_body '"emailVerified":false'
  pass "the account still signs in with its original password and is unverified"
fi
