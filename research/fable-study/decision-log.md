# Decision Log (append-only)

Entries are written by the coordinator. Format per task:

```
## <Task id> — <slug> (<date>)
- Prompt given to developer: <summary / link>
- Developer plan (as reported): …
- Notable choices & alternatives named: …
- Deviations from spec/plan: …
- Review findings (blocking / non-blocking): …
- Fix rounds: n
- Tester result & evidence: …
- Coordinator notes: …
```

---

## Setup (2026-11-15)
- Sprint plan: `docs/sprints/sprint-01.md` (T1–T11).
- Model assignment: developer agent on Fable; reviewer, tester, analyst on default.
- Base branch: `ccr-0014c7e1-32mc28`; merges squash, performed by the reviewer agent.

## T1 — monorepo-ci (2026-11-15)
- **Prompt given to developer (Fable):** self-contained brief: read `docs/sprints/sprint-01.md` T1, architecture §2, SRS NFR-MNT, test strategy §6; fixed stack; build pnpm monorepo with real placeholders, strict TS, zero-`any` rule, root scripts, CI with Postgres 16 service; explicit "do NOT add API features/auth/Prisma/UI" scope fence; PR sections Summary/Done when/Testing/Risks plus a "Plan" section; do not merge own PR; report honestly incl. what was not run.
- **Developer plan (as reported):** packages compile with `tsc` to `dist/` consumed via `exports`; API on `tsc`; web on Vite; one root ESLint config from a shared preset.
- **Notable choices & alternatives named (developer's own report):**
  - Packages consumed from `dist/` — rejected TS-source exports / custom export condition because plain-Node API cannot load `.ts` from a dependency without a bundler. Named cost: root lint/typecheck/test each run `build:packages` first.
  - Plain `tsc` — rejected Turborepo/Nx/tsup as unnecessary for a scaffold.
  - One root `eslint .` rather than per-workspace lint scripts.
  - Zero-`any` rule made type-aware (`no-explicit-any` + five `no-unsafe-*`), proven by a test that lints sample code.
  - TypeScript 6.0.3 instead of 7.0.2 (`latest`) because `typescript-eslint` 8 supports `<6.1` only.
  - Tailwind 4 via `@tailwindcss/vite` (no config files).
  - Actions pinned by major tag, CI Postgres creds as plain throwaway values (both disclosed in PR Risks).
- **Additions beyond task text (disclosed by developer):** app-to-app import lint rule (+test), `.npmrc engine-strict`, `.prettierignore`, `format`/`clean` scripts, workflow `concurrency` + `permissions: contents: read`.
- **Deviations from docs (disclosed):** CI has only install→lint→typecheck→test→build (doc 11 lists more stages; task specified fewer); mobile/desktop/prisma not created; docs/ and research/ excluded from Prettier/ESLint; status log not updated.
- **Self-reported failures before final state:** api-client build (`URL` not found → added DOM lib); ESLint on root JS files (type-aware parser rejected → disabled type-checked rules for plain JS); `packages/config` typecheck (plugin types mismatch → used `defineConfig`, registered only `rules` of react-hooks plugin). Developer states no test was weakened.
- **Developer's "not run" list:** Postgres connectivity (only container health), web app in a browser, `push` trigger.
- **Developer open questions to coordinator:** hardcoded `push` branch; pin actions by SHA; build-packages-first coupling; engine-strict. **Coordinator rulings:** leave push branch; major-tag pins OK for now; coupling accepted; engine-strict wanted.
- **Review findings (reviewer, default model):** BLOCKING none. NON-BLOCKING: build-first coupling; push trigger lists only base; `DATABASE_URL` unused until T3; TS pinned `~6.0.3` and very recent eslint/vitest majors → watch peer ranges; no `.env.example` yet (add in T2). Reviewer independently re-ran the five commands in a clean worktree and proved the zero-`any` and cross-app-import rules fire.
- **Fix rounds:** 0.
- **Merge:** PR #1 squash-merged as `b4456ba`.
- **Tester result (default model):** PASS. 30 tests in 6 files; post-merge `push` CI run 43738464010 success (first time the push trigger fired); three deliberate failure paths (any, wrong assertion, type error) each failed correctly and were reverted; real Postgres 16 reachable from Node via a one-off probe (not committed); built API starts (404 on all routes, expected); web preview serves index.html. Not verified: CI failing on a bad change; browser rendering.
- **Coordinator notes:**
  - Process observation: the developer worked directly in `/home/user/Akiba` and left the shared working tree on its task branch; coordinator had to switch back to the base branch before pulling. Future dev prompts should say "use a git worktree, leave the main tree on the base branch".
  - Coordinator deviation from skill: coordinator bookkeeping (this log, sprint status) is docs-only and is committed directly to the base branch rather than via PR; flagged to the user.

## Process change (2026-11-16, product owner)
- Reason/context: T2 developer was interrupted by a usage limit (resumed once, then stopped by the owner who asked to hold). The owner then chose to **skip reviewer, tester and merge stages** and have Fable developer agents complete all dev tasks first; module-wise analysis comes afterwards. Scope chosen: **whole MVP, M1–M6**.
- New workflow: one Fable developer per task, sequential; commits go straight to the base branch (no PRs); developers write/run their own tests and check CI on their push; full reports in `dev-reports/`; coordinator keeps this log.
- Study implication: from T2 onward there is no independent review/test evidence and no per-task analyst file. Findings about verification honesty and error recovery must come from developer self-reports plus CI results, and are weaker evidence than T1's.
- Risk noted: auth tasks T4–T6 (hand-rolled auth) land without independent review; flagged for priority analysis.
- Plan for M2–M6 tasks T12–T29: `docs/sprints/mvp-plan.md`.

## T2 — api-skeleton (2026-11-16) — no review/test stage
- Developer: Fable, interrupted once by a usage limit, resumed twice (once stopped by owner request, then restarted under the no-PR process). Pushed directly to base: `d6d7f81`, `1fc91c2`, `fb800f1`. CI and Smoke workflow green on `1fc91c2` and `fb800f1`.
- Self-reported: 75 API tests; local curl/smoke against a prod-mode build with a throwaway Postgres 16 passed. Full report: `dev-reports/T2-api-skeleton.md` (13 additions beyond task text, 6 open questions).
- Developer flags: (1) 422 only proven by supertest (no validated prod route yet); (2) `/ready` says database ok on TCP connect only — T3 must do a real query; (3) rate limits per-IP not per-user until T4; (4) problem `type` is a relative URI; (5) two of its own commands were blocked by safety checks (a stray `git checkout -- .`, an `rm -rf "$(…)"`), nothing lost; (6) not run: shellcheck, coverage, multi-instance limiter, full gate after final docs-only rebase.
- Observation (coordinator): scope fence respected per report (no Prisma/auth/domain); the developer produced a long list of additions — a pattern also seen in T1 (additions beyond task text, disclosed). Not independently verified.

## T3 — prisma-schema (2026-11-16) — no review/test stage
- Developer: Fable. Commits `13e490a` `531f850` `c62716c` `f24deee` `8fafa1b`; CI + Smoke green on `8fafa1b` (and `f24deee`). Full report: `dev-reports/T3-prisma-schema.md`.
- Self-reported: 179 API tests on real Postgres 16; `/ready` returned 503 when Postgres stopped and 200 after restart; smoke 9 checks.
- **Self-reported error:** commit `c62716c` was red on CI and Smoke — the developer piped the lint gate through `tail` (hid a failure) and pushed invalid `smoke.yml` YAML; fixed forward in `f24deee`. (Evidence for the study: error disclosed by the developer itself, recovered by fix-forward; the cause was a verification-method mistake, not a spec one.)
- Developer decisions/notes carried to `docs/sprints/carry-forward.md` (soft-remove tombstone, override-vs-progress, purge trigger setting, Prisma 7.10.1 pin, requirement-ID mismatch it noticed in the brief, doc gaps). The developer noticed my brief's requirement IDs (FR-REM-007 / FR-NOTE-002) did not match the SRS and followed the SRS — a coordinator error caught by the developer.
- Not verified (self-reported): seed facts from memory; non-superuser DB role; PG 15; concurrency.

## T4 — auth-core (2026-11-16) — no review/test stage; hand-rolled auth, PRIORITY FOR ANALYSIS
- Developer: Fable; interrupted by the 5-hour usage limit mid-task and resumed once. Commits `dcfa584` `714231f` `7a5be94` `56141cf` `7e74b41`; CI + Smoke green on head `7e74b41`. Full report incl. S-AUTH-n audit table: `dev-reports/T4-auth-core.md` (§5, §11).
- Self-reported: API tests 179 → 323; smoke 20 checks in production mode; "removing each of 7 protections in turn made a test fail every time" (mutation-style self-check).
- **Self-reported error after the interruption:** `dcfa584` failed CI (#13) — developer pushed the migration before running the full suite; a T3 raw-SQL test lacked the new column; fixed in `714231f`. Same pattern as T3 (a red push caused by a verification shortcut, found by CI, fixed forward). Two tasks in a row with one red CI push each.
- Developer flags: no independent review has occurred (open M1 exit item); unverified accounts can log in (Q-04) → T5 must send verification, T6 must not link OAuth to unverified password accounts; concurrent refresh with the same token ends the session (strict S-AUTH-6) → T7/T10 clients must serialise refresh across tabs or owner accepts a grace window; breached-password list is 180 entries from memory and HIBP is off/untested; deviations: `refresh_token.family_expires_at`, repeated logout-all with the same access token → 401, smoke leaves one account per run, prod refuses to boot without `AUTH_JWT_PRIVATE_JWK`.
- Not verified: login timing parity, real browser, multi-instance (throttle state in memory), `pnpm audit`, argon2 tuning.
- Coordinator note: the hook asked me to commit the developer's in-progress files while it was mid-task; I declined (would have pushed a red state); the developer's own commits cleared it.

## T5 — auth-email (2026-11-16/17) — no review/test stage; hand-rolled auth, PRIORITY FOR ANALYSIS
- Developer: Fable; interrupted by the 5-hour limit mid-task (left a local, unpushed WIP commit "tests pending" — recoverable state, as instructed) and resumed once. Commits `506e112` `a4839e9` `2de4ec6` `84b68a9` `c92edb4` `faa7072`; CI + Smoke green on `faa7072` and `c92edb4`; **no red runs** (T3 and T4 each had one; this brief required the full local gate before every push). Full report: `dev-reports/T5-auth-email.md`.
- Self-reported: API tests 388; production-mode smoke 27 checks (a fourth instance on port 3003 for `30-auth-email.sh`); after the interruption it re-ran everything it reported.
- Developer flags: (1) no email is delivered — only `console` provider, allowed in production with a warning → owner must choose a real provider; (2) schema change beyond brief: `one_time_token.sent_to`; (3) `WEB_BASE_URL` (https) now required in production; (4) forgot-password answers 202 *before* any account lookup instead of a dummy path, no timing measured; (5) **Q-04 still open — pre-registration risk:** unverified accounts can log in, so if a victim opens the verification link sent after an attacker pre-registered the victim's address, the attacker holds a verified account; only email wording guards against it; (6) email budget (3 per kind per address per hour) and background delivery are in process memory; (7) email change not built (carry-forward written); (8) auth module still has no independent review.
- Coordinator note: item (5) is a real account pre-hijacking pattern. Candidate mitigations for owner decision: require verified email to log in; or on first verification revoke all existing sessions and force a password reset; keep OAuth linking verified-only (T6). Left open for the module analysis — flagged in the final summary to the owner.
