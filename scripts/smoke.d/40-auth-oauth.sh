# shellcheck shell=bash
# Sourced by scripts/smoke.sh. Sign-in with Google and Apple (T6), as far as it can be checked
# without the real providers. No request in this file makes the API contact Google or Apple:
# every check is answered before a provider would be needed (configuration, validation,
# authentication, `state`). Real sign-in needs a real provider account and is NOT covered by any
# smoke run; the flows are covered by the integration tests with a fake verifier
# (apps/api/src/modules/auth/auth.oauth.test.ts).
#
# Runs against its OWN API instance, started with
#   GOOGLE_CLIENT_IDS + GOOGLE_CLIENT_SECRET set to made-up values (Google "configured"),
#   no APPLE_* variables                                           (Apple switched off),
# because the instance under test and the auth-email instance have used up their per-IP
# /v1/auth budgets.
#
#   SMOKE_AUTH_OAUTH_URL    base URL of that instance (required)
#   SMOKE_OAUTH_REDIRECT    a redirect URI on that instance's allow-list
#                           (default https://smoke.akiba.invalid/oauth/callback)
#   SMOKE_SKIP_AUTH_OAUTH   set to 1 to skip this file explicitly
#
# WRITES DATA: one row in oauth_state (used up by the checks; deleted by the next started
# sign-in after ten minutes). No account, no session.
#
# Request budget against SMOKE_AUTH_OAUTH_URL: 8 requests to /v1/auth/* (limit 10 per minute per
# IP). None to SMOKE_BASE_URL.

if [ "${SMOKE_SKIP_AUTH_OAUTH:-0}" = "1" ]; then
  echo "  SKIPPED - auth oauth checks disabled by SMOKE_SKIP_AUTH_OAUTH=1"
else
  [ -n "${SMOKE_AUTH_OAUTH_URL:-}" ] ||
    fail "SMOKE_AUTH_OAUTH_URL is not set (start the oauth instance, or set SMOKE_SKIP_AUTH_OAUTH=1)"

  oauth_url="${SMOKE_AUTH_OAUTH_URL%/}/v1/auth/oauth"
  oauth_json=(-H 'Content-Type: application/json')
  oauth_redirect="${SMOKE_OAUTH_REDIRECT:-https://smoke.akiba.invalid/oauth/callback}"

  # Random base64url strings of 43 characters: a nonce, a PKCE verifier, a state never issued.
  oauth_random() {
    head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
  }
  oauth_nonce="$(oauth_random)"
  oauth_verifier="$(oauth_random)"
  oauth_other_verifier="$(oauth_random)"
  oauth_unknown_state="$(oauth_random)"
  # PKCE S256: base64url(sha256(verifier)).
  oauth_challenge="$(printf '%s' "$oauth_verifier" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=\n')"
  grep -Eq '^[A-Za-z0-9_-]{43}$' <<<"$oauth_challenge" || fail "could not compute a PKCE challenge"

  # 1. A provider that is not configured: the documented 501 problem, for a well-formed request.
  http -X POST "${oauth_json[@]}" -H 'X-Client: mobile/smoke' \
    -d "{\"idToken\":\"not.a.token\",\"nonce\":\"$oauth_nonce\"}" "$oauth_url/apple"
  expect_status 501
  expect_problem
  expect_body '"code":"OAUTH_PROVIDER_NOT_CONFIGURED"'
  expect_header cache-control '^no-store$'
  pass "POST /v1/auth/oauth/apple is 501 OAUTH_PROVIDER_NOT_CONFIGURED when Apple is switched off"

  # 2. A malformed body is a real 422 (both credential forms mixed, plus an unknown field).
  http -X POST "${oauth_json[@]}" \
    -d "{\"idToken\":\"a.b.c\",\"nonce\":\"$oauth_nonce\",\"code\":\"x\",\"userId\":\"someone\"}" \
    "$oauth_url/google"
  expect_status 422
  expect_problem
  expect_body '"code":"VALIDATION_ERROR"'
  pass "POST /v1/auth/oauth/google with a malformed body is 422"

  # 3. Link and unlink need an access token.
  http -X POST "${oauth_json[@]}" \
    -d "{\"provider\":\"google\",\"idToken\":\"a.b.c\",\"nonce\":\"$oauth_nonce\"}" "$oauth_url/link"
  expect_status 401
  expect_problem
  expect_body '"code":"UNAUTHENTICATED"'
  http -X DELETE "$oauth_url/google"
  expect_status 401
  expect_problem
  expect_body '"code":"UNAUTHENTICATED"'
  pass "POST /v1/auth/oauth/link and DELETE /v1/auth/oauth/google are 401 without an access token"

  # 4. Starting the web flow stores a state and returns the provider URL (no provider contacted).
  http -X POST "${oauth_json[@]}" \
    -d "{\"redirectUri\":\"$oauth_redirect\",\"codeChallenge\":\"$oauth_challenge\"}" \
    "$oauth_url/google/start"
  expect_status 200
  expect_header cache-control '^no-store$'
  expect_body '"authorizationUrl":"https://accounts.google.com/o/oauth2/v2/auth?'
  expect_body "code_challenge=$oauth_challenge"
  expect_body 'code_challenge_method=S256'
  expect_body 'response_type=code'
  expect_body '&nonce='
  oauth_state="$(sed -n 's/.*"state":"\([^"]*\)".*/\1/p' <<<"$SMOKE_BODY" | head -n 1)"
  grep -Eq '^[A-Za-z0-9_-]{43}$' <<<"$oauth_state" || fail "start did not return a 43-character state"
  expect_body "state=$oauth_state"
  pass "POST /v1/auth/oauth/google/start returns an authorization URL with state, nonce and the S256 challenge"

  # 5. A state that was never issued is refused...
  oauth_finish() {
    http -X POST "${oauth_json[@]}" \
      -d "{\"code\":\"smoke-code\",\"codeVerifier\":\"$2\",\"redirectUri\":\"$oauth_redirect\",\"state\":\"$1\"}" \
      "$oauth_url/google"
  }
  oauth_finish "$oauth_unknown_state" "$oauth_verifier"
  expect_status 400
  expect_problem
  expect_body '"code":"INVALID_OAUTH_STATE"'
  pass "finishing with an unknown state is 400 INVALID_OAUTH_STATE"

  # ...and so is the real state without the PKCE verifier of the client that started the flow.
  oauth_finish "$oauth_state" "$oauth_other_verifier"
  expect_status 400
  expect_problem
  expect_body '"code":"INVALID_OAUTH_STATE"'
  pass "finishing with the real state and a wrong PKCE verifier is 400 INVALID_OAUTH_STATE"

  # 6. Apple's form_post relay only redirects to the web app.
  http -X POST -H 'Origin: https://appleid.apple.com' \
    --data-urlencode 'code=smoke-relay-code' --data-urlencode "state=$oauth_unknown_state" \
    "$oauth_url/apple/callback"
  expect_status 303
  expect_header location "/oauth/callback\\?provider=apple&state=$oauth_unknown_state&code=smoke-relay-code\$"
  expect_no_header set-cookie
  pass "POST /v1/auth/oauth/apple/callback answers 303 to the web app and sets nothing"
fi
