# shellcheck shell=bash
# Sourced by scripts/smoke.sh. Auth core end to end (T4): register → login → /me → refresh →
# replay of the old refresh token kills the session → mobile login → logout. Also the first real
# 422 from a validated production route.
#
# WRITES DATA: creates one account with a unique address under @smoke.akiba.invalid on every run
# and leaves it behind (there is no account-deletion endpoint before T17). Its sessions are all
# ended by the checks themselves.
#
#   SMOKE_WEB_ORIGIN           an origin on the API's CORS_ORIGINS allow-list; the browser flow
#                              needs it (default http://localhost:5173)
#   SMOKE_EXPECT_SECURE_COOKIE 1 (default) asserts the Secure cookie flag; 0 for a local API
#                              started with AUTH_COOKIE_SECURE=false
#   SMOKE_SKIP_AUTH            set to 1 to skip this file explicitly (e.g. a deployed API where
#                              smoke accounts are not wanted)
#
# Request budget against SMOKE_BASE_URL: 9 requests to /v1/auth/* (the per-IP auth limit is
# 10 per minute, so this file can run once per minute per client IP) and 5 to /v1/me.

if [ "${SMOKE_SKIP_AUTH:-0}" = "1" ]; then
  echo "  SKIPPED - auth checks disabled by SMOKE_SKIP_AUTH=1"
else
  auth_url="$SMOKE_BASE_URL/v1/auth"
  auth_origin="${SMOKE_WEB_ORIGIN:-http://localhost:5173}"
  auth_email="smoke-$(date +%s)-$RANDOM$RANDOM@smoke.akiba.invalid"
  auth_password="smoke $(head -c 18 /dev/urandom | base64 | tr -d '/+=') pw"
  web_headers=(-H "Origin: $auth_origin" -H 'X-Client: web/smoke')
  mobile_headers=(-H 'X-Client: mobile/smoke')
  json=(-H 'Content-Type: application/json')

  # json_string <field>: value of a top-level string field of SMOKE_BODY (tokens have no escapes).
  json_string() {
    sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" <<<"$SMOKE_BODY" | head -n 1
  }
  # refresh_cookie: value of the refresh cookie set by the last response (empty if none).
  refresh_cookie() {
    sed -n 's/^[Ss]et-[Cc]ookie: akiba_refresh=\([^;]*\).*/\1/p' <<<"$SMOKE_HEADERS" | head -n 1
  }
  expect_token_shape() {
    grep -Eq '^[A-Za-z0-9_-]{43}$' <<<"$1" || fail "$2 is not a 43-character base64url token"
  }

  # 1. A real 422 from a validated route (carry-forward from T2). Nothing is created.
  http -X POST "${json[@]}" -d '{"email":"not-an-email","password":"short","displayName":"","admin":true}' \
    "$auth_url/register"
  expect_status 422
  expect_problem
  expect_body '"code":"VALIDATION_ERROR"'
  expect_body '"path":"email"'
  expect_body '"path":"password"'
  expect_body '"path":"displayName"'
  pass "POST /v1/auth/register with an invalid body is 422 application/problem+json listing each field"

  # 2. Register.
  http -X POST "${json[@]}" \
    -d "{\"email\":\"$auth_email\",\"password\":\"$auth_password\",\"displayName\":\"Smoke Test\"}" \
    "$auth_url/register"
  expect_status 201
  expect_body '"status":"verification_pending"'
  expect_header cache-control '^no-store$'
  pass "POST /v1/auth/register is 201"

  # 3. Browser login: access token in the body, refresh token only in a hardened cookie.
  http -X POST "${json[@]}" "${web_headers[@]}" \
    -d "{\"email\":\"$auth_email\",\"password\":\"$auth_password\"}" "$auth_url/login"
  expect_status 200
  web_access="$(json_string accessToken)"
  web_refresh="$(refresh_cookie)"
  [ -n "$web_access" ] || fail "login returned no accessToken"
  expect_token_shape "$web_refresh" "the refresh cookie"
  ! grep -Fq -- "$web_refresh" <<<"$SMOKE_BODY" || fail "the refresh token leaked into the JSON body of a web login"
  expect_header set-cookie 'HttpOnly'
  expect_header set-cookie 'SameSite=Lax'
  expect_header set-cookie 'Path=/v1/auth(;|$)'
  if [ "${SMOKE_EXPECT_SECURE_COOKIE:-1}" = "1" ]; then
    expect_header set-cookie '; Secure'
  fi
  expect_header cache-control '^no-store$'
  pass "web login is 200; refresh cookie is HttpOnly; Secure; SameSite=Lax; Path=/v1/auth"

  # 4. The access token authenticates; no token does not.
  http -H "Authorization: Bearer $web_access" "$SMOKE_BASE_URL/v1/me"
  expect_status 200
  expect_body "\"email\":\"$auth_email\""
  expect_body '"emailVerified":false'
  pass "GET /v1/me with the access token returns the registered user"

  http "$SMOKE_BASE_URL/v1/me"
  expect_status 401
  expect_problem
  expect_body '"code":"UNAUTHENTICATED"'
  expect_header www-authenticate '^Bearer$'
  pass "GET /v1/me without a token is 401"

  # 5. Refresh rotates the cookie.
  http -X POST "${web_headers[@]}" -H "Cookie: akiba_refresh=$web_refresh" "$auth_url/refresh"
  expect_status 200
  rotated_access="$(json_string accessToken)"
  rotated_refresh="$(refresh_cookie)"
  expect_token_shape "$rotated_refresh" "the rotated refresh cookie"
  [ "$rotated_refresh" != "$web_refresh" ] || fail "refresh did not rotate the refresh token"
  [ -n "$rotated_access" ] || fail "refresh returned no accessToken"
  pass "POST /v1/auth/refresh is 200 and rotates the refresh token"

  # 6. Replaying the OLD refresh token fails and kills the whole family...
  http -X POST "${web_headers[@]}" -H "Cookie: akiba_refresh=$web_refresh" "$auth_url/refresh"
  expect_status 401
  expect_problem
  expect_body '"code":"INVALID_REFRESH_TOKEN"'
  pass "replaying the old refresh token is 401"

  # ...so the newest refresh token and the session's access token are dead too.
  http -X POST "${web_headers[@]}" -H "Cookie: akiba_refresh=$rotated_refresh" "$auth_url/refresh"
  expect_status 401
  expect_body '"code":"INVALID_REFRESH_TOKEN"'
  http -H "Authorization: Bearer $rotated_access" "$SMOKE_BASE_URL/v1/me"
  expect_status 401
  pass "after the replay the family is dead: newest refresh token and access token are both 401"

  # 7. CSRF: a cookie-carrying refresh without the X-Client header is refused.
  http -X POST -H "Origin: $auth_origin" -H "Cookie: akiba_refresh=$rotated_refresh" "$auth_url/refresh"
  expect_status 403
  expect_problem
  expect_body '"code":"CSRF_REJECTED"'
  pass "cookie refresh without X-Client is 403"

  # 8. Mobile login: refresh token in the body, never a cookie.
  http -X POST "${json[@]}" "${mobile_headers[@]}" \
    -d "{\"email\":\"$auth_email\",\"password\":\"$auth_password\"}" "$auth_url/login"
  expect_status 200
  expect_no_header set-cookie
  mobile_access="$(json_string accessToken)"
  mobile_refresh="$(json_string refreshToken)"
  expect_token_shape "$mobile_refresh" "the mobile refreshToken"
  http -H "Authorization: Bearer $mobile_access" "$SMOKE_BASE_URL/v1/me"
  expect_status 200
  pass "mobile login is 200 with the refresh token in the body and no cookie"

  # 9. Logout ends that session.
  http -X POST "${json[@]}" "${mobile_headers[@]}" -d "{\"refreshToken\":\"$mobile_refresh\"}" \
    "$auth_url/logout"
  expect_status 204
  http -H "Authorization: Bearer $mobile_access" "$SMOKE_BASE_URL/v1/me"
  expect_status 401
  pass "POST /v1/auth/logout is 204 and the session's access token stops working"
fi
