# MVP status (end of the T6–T29 run, 2026-11-19)

What is built, how it was checked, and — separately and plainly — what was **not** checked. The
per-task detail is in [`mvp-plan.md`](mvp-plan.md); this page is the summary a reviewer should read
first. Nothing here has been pushed: every task is a local commit, so **CI has never run** on this
work.

## Built

| Milestone | Tasks | State |
|---|---|---|
| M1 Foundation | T1–T7 | Done, except T6 (sign-in with Google/Apple), deferred by decision to the separate auth module (WIP on branch `wip/t6-auth-oauth`). Email/password auth, sessions, the web auth screens and the API client are built. |
| M2 Search & browse | T8–T14 | Done: AniList/Jikan adapters with resilience and fallback, Akiba ID resolver, discovery API, discover/season/title screens. |
| M3 Library · progress · remember | T15–T20 | Done: library, tracking, history, export, share link, account deletion/restore, web screens, a route-table-generated access-control suite. |
| M4 Explore | T21–T22 | Done: franchises, studios, characters and voice actors (API, web). |
| M5 Airing inbox | T23–T24 | Done: airing sync, idempotent fan-out, scheduler with advisory locks, inbox API and screens. |
| M6 Mobile | T25–T28 | Done except Google/Apple sign-in (same deferral): Expo app with log-in, Home, Discover, season chart, title, library, +1, shelf, history, inbox, settings, export, share link, delete/restore. |
| T29 | hardening | This page, the security checklist, the README. |

## Checked, and how

- **API:** 840 tests on a real PostgreSQL 17 (CI uses 16). Includes fault injection (a failing event
  insert rolls a library change back; a failing notification insert rolls the whole fan-out back),
  concurrency (simultaneous +1, simultaneous fan-out, simultaneous franchise recomputation, shared
  characters), seeded random sequences against invariants, and an access-control suite generated
  from the route table (unclassified route or path parameter = test failure; checked by removing a
  guard). Several of these tests were shown to fail when the behaviour they protect is removed.
- **Web:** 110 component tests; 45 browser tests in real Chrome against the built app, the built API,
  a real database and a mock of AniList that replays recorded responses; axe (WCAG 2.2 AA) in light
  and dark on every screen family.
- **Packages:** shared 33, ui-tokens 38, api-client 40, config 9 tests.
- **Mobile:** 74 component tests with the real router, providers and API client over a fake network.
  `pnpm --filter @akiba/mobile build` bundles the app for web and Android (Hermes). The web build was
  also driven by hand at 375 px against the real API: log-in, Home, Discover, a title, adding it,
  `+1` twice (persisted).
- Lint (ESLint, type-aware, no `any`), typecheck and migration drift check are clean.

## NOT checked — read this

1. **CI has never run.** Nothing is pushed. Differences between this machine (Windows, CRLF working
   copies, PostgreSQL 17, Node 22.23) and the CI runner (Linux, PostgreSQL 16) are untested. Prettier
   was checked with `--end-of-line auto` because every file here is CRLF on disk.
2. **No iOS or Android device or simulator was available.** The mobile app has only been exercised in
   Jest and as a web build. Look and feel, gestures, the keyboard, the system share sheet, secure
   storage on a real device, light/dark switching and screen-reader behaviour (VoiceOver, TalkBack)
   are unverified. Accessibility on mobile is asserted through roles, names and target sizes in
   tests, not through a screen reader.
3. **No live AniList or Jikan in tests** (by rule). Recorded AniList responses are fixtures
   (re-recorded once for characters, once for a week's airing schedule); the Jikan fixtures are
   hand-written, not recorded. Jikan supplies no cast and no airing. Behaviour against the live
   services, their rate limits and schema drift is unknown.
4. **No independent review of the auth module** (checklist item still open) and no human review of
   logs for secrets or PII.
5. **Email delivery is a stub** (`console` provider; nothing is sent). The "your account will be
   deleted" email was never written. Verification and reset links open on the web app.
6. **State is per process:** rate limits, the login throttle and the email budget live in memory. The
   scheduler's advisory locks do make jobs safe across processes, but running several API instances
   has not been tried.
7. **Scheduled jobs have only run in tests and through `pnpm jobs:run`**, never on their timers over
   hours. `mapping-refresh` is still a manual command.
8. **Seed data and the breached-password list were written without verification** against sources.
9. **Performance** (NFR) has no measurements beyond one timing assertion in the browser tests.
10. **Known test noise/flakes on this machine:** the mobile Jest run prints act warnings when a screen
    updates after a test ends; the web `explore` file once failed a single test and then passed in
    five reruns (cause not found).
11. **Not built:** push notifications and email digests (out of MVP), franchise/studio/character
    screens on mobile, the desktop app (M7), OAuth sign-in (see above), mobile deep links for emailed
    links.

## Decisions worth a second look

- `Stack.Protected` looped forever under test in Expo Router 58; guards are redirects in the group
  layouts instead. A built-in tab badge also spun forever, so the Inbox count is part of the tab
  label.
- A function-valued `style` on a Pressable is dropped by `Link asChild` (found by the 44-pt target
  check); rows use static styles.
- Franchises: seven relation kinds join titles, groups above 120 titles are re-split on the main
  line and may end up with no franchise; the cap and the kinds are judgement calls.
- Studio pages list only works Akiba has seen; casts exist only for titles fetched through AniList.
- An episode that aired more than 3 days before it was first seen is marked handled without
  notifying anyone.
- The airing sync asks only about titles someone is Watching whose status can still air.
- Export on mobile goes through the system share sheet as text; very large libraries may exceed what
  a receiving app accepts.
