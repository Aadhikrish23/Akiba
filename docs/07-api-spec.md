# API Specification (v1)

**Version:** 1.0 · **Date:** 2026-11-15 · Base path `/v1` · JSON over HTTPS · Authoritative schemas live in `packages/shared` (Zod); an OpenAPI document is generated from them.

## 1. Conventions
- **Auth:** `Authorization: Bearer <access_token>` (web also uses the refresh cookie on `/auth/refresh`). Public exceptions are marked 🔓.
- **IDs:** Akiba IDs only (`titleId`); never external IDs in paths.
- **Pagination:** cursor-based: `?limit=24&cursor=…` → `{ data: [...], nextCursor: string|null }` (limit 1–100).
- **Errors:** RFC 9457 problem details:
  `{ "type": "…/errors/validation", "title": "Validation failed", "status": 422, "code": "VALIDATION_ERROR", "detail": "…", "errors": [{"path":"progress","message":"…"}], "requestId": "…" }`
- **Status codes:** 200/201/204; 400 malformed; 401 unauthenticated; 403 forbidden; 404 not found (also for other users' resources); 409 conflict; 422 validation; 429 rate limited (`Retry-After`); 502/503 upstream unavailable.
- **Idempotency:** `Idempotency-Key` header accepted on `POST /library` and progress writes.
- **Stale data:** catalog responses include `meta: { stale: boolean, source: "anilist"|"jikan"|"cache" }`.
- **Rate limits (starting values, tunable):** auth endpoints 10/min/IP; writes 120/min/user; reads 600/min/user.

## 2. Auth 🔓
| Method & path | Purpose |
|---|---|
| `POST /auth/register` | `{email,password,displayName}` → 201, verification email sent |
| `POST /auth/login` | `{email,password}` → `{accessToken, user}` + refresh cookie / `refreshToken` for mobile (`X-Client: mobile`) |
| `POST /auth/oauth/:provider/start` | Web flow, `provider` = `google`\|`apple`: `{redirectUri, codeChallenge}` (PKCE S256; the browser keeps the verifier) → `{authorizationUrl, state, expiresIn}`. `state` is single-use and lasts 10 minutes |
| `POST /auth/oauth/google` · `/apple` | `{idToken, nonce}` (mobile) or `{code, codeVerifier, redirectUri, state}` (web) → same answer as login. 401 `OAUTH_SIGN_IN_FAILED` (any rejected token or code), 400 `INVALID_OAUTH_STATE`, 403 `OAUTH_EMAIL_NOT_VERIFIED`, 409 `ACCOUNT_EMAIL_UNVERIFIED` (an account with that address exists but was never verified: not linked, not signed in), 409 `OAUTH_PROVIDER_ALREADY_LINKED`, 501 `OAUTH_PROVIDER_NOT_CONFIGURED`, 503 `OAUTH_PROVIDER_UNAVAILABLE` |
| `POST /auth/oauth/apple/callback` | Relay for Apple's `form_post` response: 303 to `<web>/oauth/callback?provider=apple&code=…&state=…` (or `&error=…`). Issues nothing |
| `GET /auth/oauth` | Authenticated; `{hasPassword, providers}` |
| `POST /auth/refresh` | Rotates refresh token; returns new access token |
| `POST /auth/logout` | Revokes current refresh token family |
| `POST /auth/logout-all` | Revokes all families for the user |
| `POST /auth/verify-email` | `{token}` → 200 `{status:"verified"}`; any unusable token → 400 `INVALID_TOKEN` |
| `POST /auth/verify-email/resend` | Authenticated; sends a new link to the caller's own address → always 202 `{status:"accepted"}` |
| `POST /auth/password/forgot` · `/reset` | Forgot `{email}`: always 202 `{status:"accepted"}` (no user enumeration). Reset `{token,newPassword}` → 200 `{status:"password_reset"}`, all sessions revoked; any unusable token → 400 `INVALID_TOKEN` |
| `POST /auth/password/change` | Authenticated; `{currentPassword,newPassword}` → 204, other sessions revoked; wrong current password → 403 `REAUTHENTICATION_FAILED` |
| `POST /auth/oauth/link` · `DELETE /auth/oauth/:provider` | Authenticated; both → `{hasPassword, providers}`. Link: `{provider, …credential as for sign-in, currentPassword?}`; needs a verified email (403 `EMAIL_NOT_VERIFIED`) and re-authentication (the current password, 403 `REAUTHENTICATION_FAILED`; accounts without a password must have signed in within 10 minutes, 403 `REAUTHENTICATION_REQUIRED`); 409 `OAUTH_IDENTITY_IN_USE` / `OAUTH_PROVIDER_ALREADY_LINKED`. Unlink: 404 if not linked, 409 `LAST_SIGN_IN_METHOD` if it is the only way in |

## 3. Discover (authenticated)
| Method & path | Purpose |
|---|---|
| `GET /titles/search?q=&format=&limit=&cursor=` | Text search |
| `GET /titles/browse?genre=&tag=&season=&year=&format=&status=&sort=popularity|score|start_date&order=` | Filtered browse |
| `GET /seasons/current` · `GET /seasons/:year/:season` | Seasonal chart |
| `GET /titles/:titleId` | Title detail incl. user's `libraryStatus` |
| `GET /titles/:titleId/relations` | Related titles grouped by relation type |
| `GET /franchises/:franchiseId` | All titles in the franchise with user status |
| `GET /titles/:titleId/characters` | Characters and voice actors |
| `GET /studios/:studioId` · `GET /studios/:studioId/titles` | Studio page |
| `GET /characters/:characterId` | Character page and appearances |
| `GET /genres` | Genre list |

## 4. Library, tracking, remember
| Method & path | Purpose |
|---|---|
| `GET /library?status=&format=&genre=&q=&sort=&order=` | List entries |
| `POST /library` | `{titleId,status}` → 201 (409 if exists) |
| `GET /library/:entryId` | Entry with runs |
| `PATCH /library/:entryId` | `{status?, rating?, review?, isFavorite?, alertsEnabled?, notes?}` |
| `DELETE /library/:entryId` | Remove (events kept) |
| `POST /library/:entryId/progress` | `{ delta: 1 }` or `{ set: 12 }` → updated entry (+ `suggestComplete: true` at final episode) |
| `PUT /library/:entryId/episodes-total` | `{ total: 24 }` override · `DELETE` clears it |
| `POST /library/:entryId/runs` | Start a rewatch (entry must be Completed) |
| `GET /history?type=&titleId=&from=&to=` | Event timeline |
| `GET /stats` | Aggregates (later) |
| `GET /library/favorites` | Favorite entries |

## 5. Inbox
| Method & path | Purpose |
|---|---|
| `GET /inbox?unread=true` | List notifications |
| `GET /inbox/unread-count` | Badge count |
| `POST /inbox/:id/read` · `POST /inbox/read-all` | Mark read |
| `DELETE /inbox/:id` | Delete |

## 6. Account, export, sharing
| Method & path | Purpose |
|---|---|
| `GET /me` · `PATCH /me` | Profile and settings |
| `POST /me/export` | Returns export file (JSON) · `?format=csv` for library CSV |
| `DELETE /me` | Starts deletion (grace period); `POST /me/restore` within grace |
| `GET /me/share` · `PUT /me/share` · `DELETE /me/share` | Read, create/regenerate with scope, revoke |
| `GET /shared/:token` 🔓 | Read-only public list view per scope (rate-limited, no PII) |

## 7. Operations
`GET /health` (liveness) · `GET /ready` (DB + source-adapter status).

## 8. Example
```http
POST /v1/library/01J…/progress
Authorization: Bearer …
Content-Type: application/json

{ "delta": 1 }
```
```json
{
  "id": "01J…", "titleId": "01H…", "status": "watching", "progress": 17,
  "effectiveTotal": 28, "totalOverridden": false, "suggestComplete": false,
  "updatedAt": "2026-11-15T12:00:00Z"
}
```

## 9. Versioning and compatibility
Breaking changes → new prefix (`/v2`). Additive fields are non-breaking; clients must ignore unknown fields. Mobile clients send `X-Client: mobile/<version>`; the API may return `426` with a minimum supported version.
