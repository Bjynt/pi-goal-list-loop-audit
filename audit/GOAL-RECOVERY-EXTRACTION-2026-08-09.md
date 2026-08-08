# GOAL-RECOVERY-EXTRACTION-2026-08-09

Decomposition step 3 (v0.34.111): `extensions/goal-recovery.ts` extracted from
`extensions/loops/goal.ts` — the recovery machinery leaves the monolith, zero
behavior change. Sequencing per
`docs/GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md`.

## Scope moved (goal.ts → goal-recovery.ts, all exported)

Cluster A (compat sidecar):
- `consumeRecoveryResume` + `RECOVERY_RESUME_MARKER` + `RECOVERY_RESUME_FRESH_MS`

Cluster C (completion-audit recovery):
- `markCompletionAuditRecoveryPending`, `isCompletionAuditRecoveryPending`

Cluster B (main-model recovery + hourly quota probe):
- Pure helpers: `mainModelRecoveryActive`, `mainModelRecoveryKind`,
  `mainModelRecoveryReason`, `withMainModelRecoveryWindow`,
  `clearMainModelRecoveryTimer`
- Fallback selection: `mainModelFallbackRefs`, `resolveMainModel`,
  `tryMainModelFallback`
- Envelope: `holdMainModelRecovery`, `setMainModelRecoveryPause`,
  `scheduleMainModelRecoveryTimer`, `manuallyResumeMainModelRecovery`
- Probes: `probeMainModelRecovery`, `parkMainModelAfterFailure`,
  `recoverMainModelFromSendStorm`, `mainModelRecoverySucceeded`
- Hourly ticker (v0.34.92): `scheduleHourlyProbe`, `fireHourlyProbe`,
  `cancelHourlyProbe`

## Module structure

- `RecoveryFlags` accessor object: 12 goal.ts-owned module flags observed via
  get/set (`completionAuditRecoveryArmed`, `mainModelRecoveryTimer`,
  `mainModelSwitchInFlight`, `mainModelAbortForRecovery`,
  `lastMainModelFailure`, `hourlyProbeTimer`, `hourlyProbeFireAt`,
  `sessionGeneration`, `extensionApi`, `extensionApiStale`,
  `continuationDispatchStoodDown`, `lastLongLivedFailureAt`).
- `RecoveryDeps` factory deps: goal.ts-owned functions passed at wiring time
  (`activeGoalSurfaceCommand`, `clearDetachedAuditRuntime`, `updateGoal`,
  `clearContinuationTimer`, `freshCtxForGeneration`, `isSupervising`,
  `notifyExternal`, `persistState`, `recoverySurfaceCommand`,
  `scheduleContinuation`, `scheduleSessionTimeout`).
- `createGoalRecovery(flags, deps)` called in goal.ts after
  `createGoalLoop`/`createGoalCommands` (same wiring pattern as step 2).
- One-way imports: goal-recovery.ts imports from goal-state, goal-loop-core,
  goal-loop-auditor-process, main-model-recovery, goal-settings, goal-loop —
  never from goal.ts / goal-commands.ts.

## Verification

- `tsc --noEmit` exit 0.
- `bun test`: 1146 pass / 1 skip / 0 fail (103 files).
- 22 moved function names absent from goal.ts (grep `function <name>(` = 0).
- recovery ledger event names byte-identical in goal-recovery.ts
  (`main_model_failover`, `main_model_fallback_unavailable`,
  `main_model_probe`, `main_model_probe_failed`, `main_model_recovered`,
  `main_model_recovery_wait`, `main_model_recovery_manual_hold`,
  `forbidden_model_fallback_blocked`, `hourly_probe_scheduled`,
  `hourly_probe_fired`, `audit_recovery_pending`).
- 6 source pins in 4 test files re-anchored to goal-recovery.ts
  (retry-bounds, hourly-quota-probe, quota-wall-engagement,
  blocked-pause-autoclear, mode-command-guidance).

## Line count

goal.ts: 8,643 → 8,162 (−481). goal-recovery.ts: 696.
