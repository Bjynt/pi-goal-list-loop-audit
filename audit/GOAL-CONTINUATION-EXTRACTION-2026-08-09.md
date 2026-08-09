# GOAL-CONTINUATION-EXTRACTION (v0.34.113) — decomposition step 5

Date: 2026-08-09
Series: goal.ts decomposition (positioning doc: `docs/GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md`)
Step: 5 of 7 — extract the continuation/dispatch cluster from `extensions/loops/goal.ts` into `extensions/goal-continuation.ts`.

## What moved

From `extensions/loops/goal.ts` (7,683 → 7,054 lines, DELTA −714) into the new
`extensions/goal-continuation.ts` (962 lines, ≤2,000 contract):

1. **Continuation start timeout + watchdog** (v0.34.88/v0.34.11): the 30s
   first no-turn-start window (`CONTINUATION_START_TIMEOUT_MS`, env
   `GLLA_CONTINUATION_START_TIMEOUT_MS`), the 60s single retry backoff
   (`NO_TURN_START_RETRY_BACKOFF_MS`), the compaction re-arm cap
   (`COMPACTION_REARM_CAP`, per-record `continuationStartCompactionRearms`),
   `continuationStartTimeoutMs` / `continuationRetryBackoffMs` + the two
   test hooks (`__testOnlySetContinuationStartTimeout` /
   `__testOnlySetContinuationRetryBackoff`, re-exported from goal.ts).
2. **Dispatch sidecar lifecycle** (v0.34.24+): `dispatchLabel`,
   `dispatchLedgerValue`, `dispatchPrepare`, `dispatchFailed`,
   `dispatchStartAcknowledged`, `dispatchStartUnacknowledged`,
   `armContinuationStartWatchdog`, `retryContinuationDispatch`,
   `dispatchAccepted`, `releaseContinuationDispatchStandDown`.
3. **Queue-stuck probe** (v0.34.16): `queueStuckProbeMs`,
   `armQueueStuckProbe`.
4. **Schedule/send paths**: `scheduleContinuation`, `sendContinuation`,
   `sendStallEscalation` (P1), `sendLengthContinue` (v0.27.2).
5. **Post-compaction resync + prompt assembly**: `buildPostCompactResync`,
   `continuationPrompt` (incl. the FULL-AUDIT MODE + vision-assist +
   auditor-TODO directives).
6. **Send-rearm storm accounting** (E3/v0.28.5, v0.34.57/v0.34.102):
   `sendRearmDelayMs`, `accountSendRearm`, `escalateSendRearmStorm`,
   `noteCompactionRearm`, `clearCompactionRearms`, the
   `SEND_REARM_LEDGER_MILESTONES_MS` / `SEND_REARM_ESCALATE_SILENT_MS`
   constants, the `lastNoTurnStartedNotifiedAt` one-shot gate.

Moved module state (owned HERE, observed from goal.ts only via accessors):
`continuationTimer`, `continuationScheduledFor`, `continuationStartTimer`,
`pendingContinuationDispatch`, `continuationDispatchStoodDown`,
`lastContinuationSentPayload`, `lastContinuationSentAt`, `queueStuckProbe`,
`continuationRearmStreak/Since/Milestone`, `lastNoTurnStartedNotifiedAt`,
`continuationStartCompactionRearms`, the two override lets.

## Wiring

- `extensions/loops/goal.ts` imports the moved functions + accessors +
  `type ContinuationFlags` / `type ContinuationDeps` from
  `../goal-continuation.js` (one import block), and re-exports the two
  `__testOnlySet*` test hooks.
- `continuationFlags`: accessor object for the goal.ts-owned lets the
  cluster reads/writes (sessionGeneration, sessionHandoffPending,
  initialSessionLoadPending, extensionApiStale, staleTerminalDone,
  zombieStoodDown, extensionApi, postCompletionSettleUntil (get+set),
  postCompactResyncPending (get+set), abortedStandDown (get+set),
  lastCompactionAt, lastActivityAt, lastRealActivityAt,
  loopRearmStreak/Since/Milestone (get+set), completionAuditInFlight,
  lastLongLivedFailureAt).
- `continuationDeps`: goal.ts functions/values the cluster calls (instanceId,
  GOAL_EVENT_ENTRY, LIST_COMPLETION_SETTLE_MS, persistState, updateGoal,
  refreshUI, notifyExternal, noteActivity, rememberCtx, freshCtx,
  freshCtxForGeneration, probeExtensionApiStale, goStaleTerminal,
  isForeignCtx, sessionManagerId, isActionableGoal, isSupervising, goalNoun,
  activeGoalSurfaceCommand, scheduleSessionTimeout).
- `createGoalContinuation(continuationFlags, continuationDeps)` is called in
  goal.ts right before `createGoalLoop(loopDeps)`.

## Invariants (from the positioning doc)

- Zero behavior change: moved function bodies are byte-identical except
  mechanical `flags.X` accessor re-spellings and dep re-spellings; all
  ledger event names unchanged (`goal_continuation_sent`,
  `goal_continuation_send_failed`, `continuation_dispatch_*`,
  `send_rearm_*`, `queue_stuck_detected`, `stall_escalation_*`,
  `length_continue_*`, …).
- One-way imports: `goal-continuation.ts` NEVER imports from
  `../loops/goal.ts` (checked: no `from "../loops/goal"` in the file).
- `grep -cE 'function (scheduleContinuation|sendContinuation|runContinuationTick|continuationStartTimeoutMs|continuationRetryBackoffMs)' extensions/loops/goal.ts` = 0.
- Timer/dispatch module-level mutables follow the accessor pattern: state
  stays behind accessor getters in the new module, never read directly from
  goal.ts (`loopTimer === null` re-spelled to `!continuationTimerPending()`
  at the settle probes).
- Test-only hooks stay exported for source-pinned tests: the two
  `__testOnlySet*` continuation hooks are re-exported from goal.ts;
  `__testOnlySetLastCompactionAt` remains in goal.ts.

## Real bug fixed by the move

`continuationPrompt` kept `path.resolve(__dirname, "..", "..", "prompts",
"goal-loop-continuation.md")` (the old two-level depth from
`extensions/loops/`), but the moved file lives in `extensions/` — one level.
The template failed to load, the payload became `[template-not-found]`, the
dispatch marker vanished, and the start-proof never settled (79-test
behavioral failure wave). Fixed to `path.resolve(__dirname, "..", "prompts",
…)` (goal-continuation.ts:875). The behavioral orchestrator suite passes
again (76/76) and the full suite is green.

## Test-pin re-anchoring (9 files)

Moved strings were re-pinned to a `CONT` const reading
`extensions/goal-continuation.ts`; pins that regex-match moved code were
re-spelled to the `flags.X` accessor form; pins that stayed in goal.ts were
NOT weakened. Affected files:

1. `tests/prompt-pivot-detection.test.ts` (FULL-AUDIT MODE directive +
   aggressiveMode gate in `continuationPrompt`)
2. `tests/stale-api-terminal.test.ts` (sendContinuation stale guards,
   `probeExtensionApiStale()` no-ctx send path)
3. `tests/image1-list-stall-and-count-fix.test.ts` (settle window in
   scheduleContinuation/dispatchStartAcknowledged/sendContinuation)
4. `tests/display.test.ts` (buildPostCompactResync try/catch containment)
5. `tests/quota-wall-engagement.test.ts` (sendStormEscalateMs threshold +
   escalateSendRearmStorm recovery funnel)
6. `tests/retry-bounds.test.ts` (accountSendRearm/sendRearmDelayMs/
   SEND_REARM_ESCALATE_SILENT_MS/escalateSendRearmStorm/
   retryContinuationDispatch kind-check/scheduleContinuation)
7. `tests/length-continue.test.ts` (sendLengthContinue guards + ledger;
   `resetLengthContinue` factory-reset pin stays in goal.ts)
8. `tests/pause-informativeness.test.ts` (send-retry storm pause pair →
   CONT; the rest of the pairs stay on SRC)
9. `tests/stall-handling.test.ts` (ledger events, sendStallEscalation,
   escalateSendRearmStorm audit-lifecycle suppression, watchdog consts,
   queue-stuck probe, resync block, stand-down clear — plus
   `continuationTimer === null` → `!continuationTimerPending()` re-spells
   at the two goal.ts settle probes)

## Verification

- `bun test`: 1146 pass / 1 skip / 0 fail, 1147 tests across 103 files.
- `npx tsc --noEmit`: clean.
- `wc -l extensions/goal-continuation.ts` = 962 (≤2,000 contract).
- Contract checks: moved fn names absent from goal.ts; no
  `from "../loops/goal"` import in goal-continuation.ts;
  `createGoalContinuation` wired in both files; ledger event names
  unchanged; two `__testOnlySet*` hooks re-exported from goal.ts.
