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
