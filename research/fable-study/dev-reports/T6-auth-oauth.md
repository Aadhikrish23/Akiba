# T6 auth-oauth: developer report

**Task:** Google and Apple sign-in (ID-token path for mobile, authorization-code + PKCE for web), link/unlink.
**Requirements:** FR-AUTH-002, FR-AUTH-007; doc 09 S-AUTH-9, S-AUTH-12, §4, §7; doc 07 §2; D-07; Q-04.
**Branch:** `ccr-0014c7e1-32mc28`. No reviewer or tester looked at this; section 5 is a self-audit, not a review.

## 1. Plan (written before any code)

1. Read carry-forward, sprint T6, doc 09, doc 04 FR-AUTH-002/007, doc 07 §2, D-07/Q-04, the T4 and T5 reports and the auth module.
2. `OidcVerifier` interface. Real implementation on `jose` with one profile per provider (issuers, JWKS URL, allowed algorithm, allowed client IDs) and an injectable key resolver, so tests verify real signatures against keys made in the test. Fake implementation for flow tests.
3. `OAuthCodeExchanger` interface. Real implementation posts to the provider token endpoint with a timeout; endpoints are injectable so its request can be checked against a local HTTP server.
4. Web flow with a server-side record: `POST /v1/auth/oauth/:provider/start` takes the redirect URI and the PKCE challenge, stores a hashed single-use `state` with a server-made `nonce` for 10 minutes and returns the authorization URL. The browser keeps the PKCE verifier; presenting it later is what ties the completion to the browser that started.
5. Account rules in one function, in this order: provider identity → verified-email match → new user. Refuse when the provider email is unverified or missing, and when the matching account's address is unverified.
6. Link (`POST /v1/auth/oauth/link`) and unlink (`DELETE /v1/auth/oauth/:provider`) with last-method protection inside a serializable transaction.
7. Config (all optional), shared Zod DTOs, `.env.example`, redaction keys.
8. Migration: `oauth_state` table and a unique `(user_id, provider)` on `oauth_account`.
9. Tests on real Postgres with the fake verifier; verifier tests with local keys; exchanger test with a local HTTP server; smoke file `40-auth-oauth.sh`.
10. Full gate, push, check CI and Smoke, finish this report, carry-forward, sprint status.

The sections below were written after the work.
