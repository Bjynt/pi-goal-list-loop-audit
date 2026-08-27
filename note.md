# Now

Active list drained — `goal:null list:0`. Last two items both auditor-approved:
- `20260827200116-bvgqsu` /glla bug capture — `bugs/<ts>-<id>.md` via `resolveGllaStateDir`, no durable mutation.
- `20260827203924-m13p3a` wait/duration — `estimateDurationFromHistory`/`nextPollMs` + `smoke.sh` `250→1000ms` adaptive, `audit/WAIT-ESTIMATION-2026-08-27.md`.

No active follow-up; awaiting next list.

# Done

- **Useful summary when objective completes** — six-label `Outcome:/Changed:/Evidence:/Tests:/Unresolved:/Next:` enforced in `goal-auditor-hooks.ts:validateCompletionSummary`, `audit/COMPLETION-SUMMARY-AUDIT-2026-08-27.md`, `tests/completion-summary-quality.test.ts` — `20260827193226-7ih651` approved.
- **README/Pi Store thumbnail** — `media/glla2.png` (bust cache), `README.md:4` + `package.json:files` → `npm pack` includes `media`, commits `032f1761`/`ad5bd85d`.
- **Fewer mid-execution questions** — `goal-continuation.ts` safe `freshCtx?.()?.cwd`, single `ACTIVE_EXECUTION_QUESTION_GUIDANCE` via `goal-loop-continuation.md`, `designer-drafter-policy.test.ts` — `20260827153038-hr4q8b` approved.
- **Status-aware waiting** — `scripts/durable-wait.mjs` + `scripts/smoke.sh` durable poller, `tests/durable-wait.test.mjs`, `audit/WAIT-POLL-2026-08-27.md` — `61490f2e`/`d6e4b41`.
- **/glla bug capture** — see Now above.
- **Wait/duration estimation** — see Now above.
- **Status-surface / 8-report reconciliation** — `audit/GITHUB-MAINTAINER-INVENTORY-2026-08-25.md`, v0.35.71 public no-stream containment.

# Later

- **audit other goal plugins** — `pi-goal-x` as reference for gap closure (deferred per your call; queued after active list).

# Idea

_(none — prior ideas promoted to Done)_
