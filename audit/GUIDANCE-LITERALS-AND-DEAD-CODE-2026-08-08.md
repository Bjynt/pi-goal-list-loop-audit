# Guidance Literals Fixed + Dead-Code Sweep — v0.34.108

Source audit (subagent c6206c9d-b979-467, run 2026-08-08, v0.34.105
baseline) — top findings shipped in this version.

verification: bun test → 1142 pass / 1 skip / 0 fail (102 files);
`npx tsc --noEmit` clean; version 0.34.108; tests
`mode-command-guidance.test.ts` (8), `auditor-unmatched-telemetry.test.ts`
(12), `auditor-error-paths.test.ts` (4), `stale-api-terminal.test.ts` (14),
`display.test.ts`, `retry-bounds.test.ts` all green after re-anchoring.

## 1. Mode-command-guidance contract violations (7 sites, all fixed)

The audit found 11 `/goal` literal matches in goal.ts; 7 were violations of
the v0.34.51 contract (generated guidance must interpolate through
`activeGoalSurfaceCommand()` / `activeGoalStatusCommand()`, never hardcode
`/goal <verb>`):

| Site | Context | Fix |
|---|---|---|
| ~2921 / ~3030 | `pauseSuggestedAction` manual-hold + wait-park | `recoverySurfaceCommand(normalized.kind, "resume")` |
| ~7098 | `complete_goal` tool text (paused goal) | `activeGoalSurfaceCommand("resume")` |
| ~10465 / ~10479 | `session_start` recovery notifies | `recoverySurfaceCommand(mainRecovery.kind, "resume")` |
| ~10521 | quota-claim wait notify | `activeGoalSurfaceCommand("resume")` |
| ~10618 | restore pauseSuggestedAction hint | `activeGoalSurfaceCommand("resume")` |

New helper `recoverySurfaceCommand(kind: "goal" | "loop", command)` extends
`activeGoalSurfaceCommand` (which keys off the goal policy only) with the
loop surface — the main-model recovery paths park a METRIC LOOP too, and a
parked loop resumed through `/goal resume` would be wrong.

Non-violations kept (by test convention): the cross-surface enumeration
`/goal resume, /list resume, or /loop resume` (continuation timeout message),
the ledger `via:` literal, and the archived-goal surface map.

## 2. Source-pin blind spot closed

The pin only scanned lines carrying guidance trigger tokens
(`pauseSuggestedAction | notify( | lines.push | text: | description:`), so
a literal parked on a `const resumeCmd = ...` assignment line escaped — the
exact shape of all 7 violations. The pin now also scans const/let assignment
lines. A second new pin asserts recovery guidance never hardcodes
`/loop resume` on assignment lines (loop-only contexts may keep theirs — no
mode ambiguity there). Verified the old violation shapes are caught by the
strengthened pin (all 3 shapes → caught).

## 3. Dead-code sweep

- `runGoalCompletionAuditor` (goal-loop-auditor.ts, ~280) — superseded by
  `runDetachedGoalCompletionAuditor`; removed with its private machinery
  (`makeAuditorResourceLoader`, `modelLabel`, 9 now-unused imports).
- 4 `__testOnly*` hooks never called: `__testOnlyResetStallState`,
  `__testOnlySetHourlyProbeNow`, `__testOnlyResetHourlyProbe`,
  `__testOnlyHourlyProbeState` — plus `hourlyProbeClockOverride`, whose only
  readers were the removed hooks. `__testOnlyResetOwnerSession` /
  `__testOnlyResetStaleFlag` deliberately kept (imported by tests).
- Dead locals: `quotaRetryStreak` (written 4×, never read — durable
  `pendingCompletion.quotaAttempts` is authoritative), `SEND_REARM_ESCALATE_AFTER_MS`
  (superseded by `sendStormEscalateMs()`), `consecutiveNoToolIterations`.
- 8 unused imports in goal.ts (`mergeSettings`, `cloneGoal`,
  `isQuotaWallError`, `ModelSwitchRecord`, `MAIN_MODEL_MAX_RETRY_DELAY_MS`,
  `DEFAULT_SETTINGS`, `SETTINGS_KEYS`, `DEFAULT_REVIEWER_CONFIG`).
- display.ts dead helpers `sinceIso` / `stateBadge` / `shortClock` and the
  unused `auditorPhase` computation in `goalLines`.

### Re-anchored pins (invariants preserved, production path)

Deleting the dead in-process auditor broke 8 source pins that anchored on
it. All were re-anchored to the production path; the guarded invariants all
still hold in goal-loop-auditor-process.ts + scripts/goal-auditor-worker.mjs:

- infra failures never return `disapproved: true` (catch blocks route
  through `infra()`; "no auditor model" / "Auditor aborted." / wall-clock
  bound all `disapproved: false`);
- detached auditor children are killed on teardown
  (`child.kill("SIGTERM")`);
- the abort listener is removed in finally
  (`args.signal?.removeEventListener("abort", abort)`);
- the process module forwards worker pairing data verbatim — no inline
  slot mutation or re-pairing outside the pure `applyToolExecutionEvent`;
- `quotaRetryStreak = 0` pin → durable manual-origin reset
  (`quotaAttempts: undefined`);
- `SEND_REARM_ESCALATE_AFTER_MS` pin → asserted REMOVED, activity gate
  (`SEND_REARM_ESCALATE_SILENT_MS`) still pinned.

## Note on suite variance

First post-edit full runs showed the known auto-committer daemon contention
signature (205 pass / 80 fail / 78 errors = test() outside-context races
from the daemon writing files mid-run). Clean run after the daemon settled:
1142 pass / 1 skip / 0 fail.
