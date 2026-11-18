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
| `POST /auth/oauth/google` · `/apple` | `{idToken, nonce}` (mobile) or code+PKCE (web) → tokens |
| `POST /auth/refresh` | Rotates refresh token; returns new access token |
| `POST /auth/logout` | Revokes current refresh token family |
| `POST /auth/logout-all` | Revokes all families for the user |
| `POST /auth/verify-email` | `{token}` → 200 `{status:"verified"}`; any unusable token → 400 `INVALID_TOKEN` |
| `POST /auth/verify-email/resend` | Authenticated; sends a new link to the caller's own address → always 202 `{status:"accepted"}` |
| `POST /auth/password/forgot` · `/reset` | Forgot `{email}`: always 202 `{status:"accepted"}` (no user enumeration). Reset `{token,newPassword}` → 200 `{status:"password_reset"}`, all sessions revoked; any unusable token → 400 `INVALID_TOKEN` |
| `POST /auth/password/change` | Authenticated; `{currentPassword,newPassword}` → 204, other sessions revoked; wrong current password → 403 `REAUTHENTICATION_FAILED` |
| `POST /auth/oauth/link` · `DELETE /auth/oauth/:provider` | Link/unlink provider (authenticated) |

## 3. Discover (authenticated)
| Method & path | Purpose |
|---|---|
| `GET /titles/search?q=&format=&limit=&cursor=` | Text search |
| `GET /titles/browse?genre=&season=&year=&format=&status=&sort=popularity|score|start_date&limit=&cursor=` | Filtered browse. `tag` and `order` are not offered: the sources only sort descending and tags are post-MVP |
| `GET /seasons/current` · `GET /seasons/:year/:season` | Seasonal chart (accepts `genre`, `format`, `sort`, `limit`, `cursor`; the answer adds `season` and `seasonYear`) |
| `GET /titles/:titleId` | Title detail incl. user's `libraryStatus`; `meta` says whether it is stale; 404 for an unknown or adult title; 503 `SOURCES_UNAVAILABLE` if it was never fetched and no source answers |
| `GET /titles/:titleId/relations` | Related titles grouped by relation type |
| `GET /franchises/:franchiseId` | `{data:{id,name,titles[],relations[],totals},meta}`: every visible title, oldest first (unknown dates last), each a card with `startDate` and the caller's `libraryStatus`/`libraryEntryId`; `relations` are the `{fromTitleId,toTitleId,relationType}` edges between those titles; `totals` = `{titles,inLibrary,completed}` for the caller. A title detail carries its `franchiseId` (null when it has none) |
| `GET /titles/:titleId/characters` | `{data:[{id,name,nativeName,imageUrl,role,voiceActors:[{id,name,nativeName,imageUrl,language}]}],meta}`, main characters first. Refreshes the title's detail when it is old; a title whose cast is empty is looked at again at most hourly |
| `GET /studios/:studioId` · `GET /studios/:studioId/titles?limit=&cursor=` | `{data:{id,name,isAnimationStudio,titleCount}}`, and the studio's works as an ordinary title list, most popular first (unknown popularity last). Only works Akiba has seen are listed: a studio fills in as titles are opened |
| `GET /characters/:characterId` | `{data:{id,name,nativeName,imageUrl,description,voiceActors[],appearances:[{role,title:card}]}}`, main roles first, at most 50 |
| `GET /genres` | Genre list (adult-only labels are left out) |

Franchise, studio and character pages read Akiba's own copy (`meta: {stale:false, source:"cache"}`), hide adult-rated titles unless the user opted in, and answer 404 for an unknown or malformed ID or when nothing visible is left (an adult-only franchise, studio or character is not discoverable by ID).

All discover endpoints return `meta: { stale, source }` (`anilist` | `jikan` | `cache`). Lists are `{ data, nextCursor, meta }`; the cursor is opaque and keeps its page size. Nothing outside the sources' own URLs carries an external ID: only Akiba IDs.

## 4. Library, tracking, remember
| Method & path | Purpose |
|---|---|
| `GET /library?status=&format=&genre=&minRating=&year=&q=&sort=updated|title|rating|progress|start_date&order=&limit=&cursor=` | List entries (`q` matches any part of a title; `start_date` is when the user started; default sort is recently updated) |
| `POST /library` | `{titleId,status}` → 201 with the entry and run 1; 409 `ALREADY_IN_LIBRARY` (carries `entryId`) if it is on the shelf. A title removed earlier is revived as a new run |
| `GET /library/:entryId` | Entry with runs |
| `PATCH /library/:entryId` | `{status?, rating?, review?, isFavorite?, alertsEnabled?, notes?}` |
| `DELETE /library/:entryId` | Remove (tombstone: the entry and its events are kept) → 204 |
| `POST /library/:entryId/progress` | `{ delta: 1 }` (or `-1`) or `{ set: 12 }` → `{ data: entry, suggestComplete }`. 422 `PROGRESS_EXCEEDS_TOTAL` (with `total`) past a known total; 409 `ENTRY_COMPLETED` on a completed entry; the first episode moves Planned to Watching |
| `PUT /library/:entryId/episodes-total` | `{ total: 24 }` override · `DELETE` clears it. 422 `TOTAL_BELOW_PROGRESS` if it would drop below the episodes watched (refused, never clamped) |
| `POST /library/:entryId/runs` | Start a rewatch (entry must be Completed, else 409 `NOT_COMPLETED`) → 201 with run N+1 open; earlier runs unchanged |
| `GET /history?type=&titleId=&from=&to=&limit=&cursor=` | Event timeline, newest first (`type` may list several, comma separated; `from` inclusive, `to` exclusive; keyset cursor). Events have no write routes: they are append-only |
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
| `GET /me` · `PATCH /me` | Profile and settings: `displayName`, `titleLanguage`, `timeZone`, `libraryView`, `alertsEnabled`, `showAdult` (adult-rated titles, off by default: Q-10) |
| `POST /me/export` | Returns the export file (JSON, `exportVersion` 1: entries with runs, events, favourites, titles with their external IDs) · `?format=csv` for a library spreadsheet (cells that could run as formulas are neutralised) |
| `DELETE /me` | `{ password }` → 202. Ends every session and schedules erasure after 14 days. **Restore** is `POST /auth/restore` `{ email, password }` (public: a deleted account cannot sign in), same throttling and one uniform error as login |
| `GET /me/share` · `PUT /me/share` · `DELETE /me/share` | Status (never the token), create/regenerate with `{ scope: { statuses, showRatings, showReviews } }` (needs a verified email; the response is the only one that carries the token), revoke (idempotent). The old link stops working the moment it is replaced or revoked |
| `GET /shared/:token` 🔓 | Read-only public list per scope: `{ owner: { displayName }, scope, data, nextCursor }`. 60/min per IP; every bad token is the same 404; `noindex`, `no-referrer`, `no-store`; adult titles and removed entries are left out; ratings and reviews are absent unless the scope shows them |

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
