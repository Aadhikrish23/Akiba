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
