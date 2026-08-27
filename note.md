# Now

Active list drained — `goal:null list:0`. Last two items both auditor-approved:
- `20260827200116-bvgqsu` /glla bug capture — `bugs/<ts>-<id>.md` via `resolveGllaStateDir`, no durable mutation.
- `20260827203924-m13p3a` wait/duration — `estimateDurationFromHistory`/`nextPollMs` + `smoke.sh` `250→1000ms` adaptive, `audit/WAIT-ESTIMATION-2026-08-27.md`.

No active follow-up; awaiting next list.

# Done

Keep only the three most recent completions here; older history lives in
`audit/DONE-ARCHIVE.md`.

- **Wait/duration estimation** — `scripts/durable-wait.mjs:estimateDurationFromHistory`/`nextPollMs` + `scripts/smoke.sh` `250→1000ms` adaptive polling, `audit/WAIT-ESTIMATION-2026-08-27.md` — `20260827203924-m13p3a` approved.
- **/glla bug capture** — `extensions/goal-commands.ts:cmdGllaBug` writes `bugs/<ts>-<id>.md` via `resolveGllaStateDir` without mutating durable state — `20260827200116-bvgqsu` approved.
- **Useful summary when objective completes** — six-label `Outcome:/Changed:/Evidence:/Tests:/Unresolved:/Next:` enforced in `goal-auditor-hooks.ts:validateCompletionSummary`, `audit/COMPLETION-SUMMARY-AUDIT-2026-08-27.md`, `tests/completion-summary-quality.test.ts` — `20260827193226-7ih651` approved.

# Later

- **audit other goal plugins** — `pi-goal-x` as reference for gap closure (deferred per your call; queued after active list).

# Idea

_(none — prior ideas promoted to Done)_
