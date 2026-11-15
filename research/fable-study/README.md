# Fable Behaviour Study

**Purpose:** a reference for later projects on how the Fable model behaves and makes decisions when it builds software in a sprint loop.
**Scope:** Sprint 1 and onward of Akiba. Developer agent runs on Fable; reviewer, tester and coordinator run on the default model.

## What this study is — and is not
- It **is** a record of *observable behaviour*: what Fable decided, what alternatives it named, how it responded to review findings, where it erred, how it recovered, how it handled ambiguity and instructions.
- It is **not** an account of the model's internal mechanisms. An agent cannot inspect its own reasoning process, so no claim here describes internals. Anything inferred is marked **[inference]** and anything directly evidenced is marked **[evidence: <link>]**.

## Method
1. The coordinator appends to [`decision-log.md`](decision-log.md) after every task: the prompt given, the developer's reported plan, notable choices, deviations, and review/test outcomes.
2. After each task is merged and tested, the analyst agent reads the decision log, the PR (description, diff summary, review comments), commits, CI results and the developer's report, then writes `observations/task-<id>.md`.
3. At the end of each sprint the analyst updates [`synthesis.md`](synthesis.md): recurring patterns, strengths, failure modes, and prompting guidance, each tied to evidence.

## Layout
| Path | Content |
|---|---|
| `decision-log.md` | Raw, append-only log written by the coordinator |
| `observations/task-<id>.md` | Per-task analysis (one file per task) |
| `synthesis.md` | Cross-task patterns and practical guidance |
| `templates/observation.md` | Template for observation files |

## Observation dimensions
Planning and decomposition · scope control · handling of ambiguity · use of the spec docs · security reasoning · test design · responsiveness to review · error recovery · verification honesty (does it report what it did *not* run?) · communication quality · efficiency (rounds needed).

## Rules
- Evidence over opinion; quote briefly, link to PRs/commits.
- Report negative findings with equal weight.
- No secrets, tokens or personal data.
- Do not edit the decision log retroactively; add dated corrections.
