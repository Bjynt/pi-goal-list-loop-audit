# GOAL-HEARTBEAT-EXTRACTION (v0.34.112) — decomposition step 4

Date: 2026-08-09
Series: goal.ts decomposition (positioning doc: `docs/GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md`)
Step: 4 of 7 — extract the heartbeat/watchdog cluster from `extensions/loops/goal.ts` into `extensions/goal-heartbeat.ts`.

## What moved

From `extensions/loops/goal.ts` (8,162 → 7,683 lines) into the new `extensions/goal-heartbeat.ts` (702 lines):

1. **Band 1993–2491 (original numbering)**: the entire heartbeat cluster —
   `heartbeatTick` (stale probe, stale-latch stranded-audit park, self-heal,
   compaction grace gate, zombie-run watchdog, unanswered-continuation
   fallback, post-compaction resume debt, context-starvation refuse gate,
   pending-latch watchdog, wedge alert, refire + escalation) and
   `startHeartbeat`.
2. **Subagent-hang machinery**: `SubagentHangProbe` interface,
   `subagentHangProbes` map, `SUBAGENT_MANAGER_KEY`,
   `upsertSubagentHangProbe`, `markSubagentHangProgress`,
   `endSubagentHangProbe`, `classifyHungSubagents`.
3. **Module-level state owned by the heartbeat** (mirror-lets inside the
   factory): `heartbeatStaleDebounce` + `HEARTBEAT_STALE_DEBOUNCE`,
   `ZOMBIE_RUN_SILENT_MS`, `ZOMBIE_RUN_ALERT_THROTTLE_MS`,
   `lastZombieAlertAt`, `lastWedgeAlertAt`, `lastUnansweredAlertAt`,
   `lastStarvedRefusedAt`.
4. **Test hooks**: `__testOnlyHeartbeatTick`, `__testOnlyHeartbeatTickRaw`,
   `__testOnlySetHeartbeatStaleDebounce`, `__testOnlySubagentHangProbes`,
   `__testOnlyClearSubagentHangProbes`.

## What stays in goal.ts

- The 28 observable flags behind `HeartbeatFlags` accessor pairs (same
  mirror-lets pattern as `RecoveryFlags`/`LoopFlags` in steps 1–3).
- `CONTINUATION_UNANSWERED_MS` / `CONTINUATION_UNANSWERED_THROTTLE_MS`
  (env-driven, used by continuation machinery) — passed into the factory
  as `HeartbeatDeps` VALUES.
- `escalateStallNow` (the stall-escalation ledger lives here), the
  `session_compact` hook, `noteActivity`, `onCompactionLanded`,
  `probeExtensionApiStaleRaw`, `tryAbsorbHostSuccessor`, `goStaleTerminal`,
  `absorbStaleIfSuperseded`, `scheduleContinuation`, queue-stuck probe
  machinery, and all continuation/dispatch machinery (step 5 territory).

## Wiring

- `extensions/loops/goal.ts` imports
  `{ createGoalHeartbeat, startHeartbeat, upsertSubagentHangProbe,
  markSubagentHangProgress, endSubagentHangProbe, type HeartbeatDeps,
  type HeartbeatFlags }` from `../goal-heartbeat.js` (exactly one import).
- `heartbeatFlags` (28 accessor pairs) + `heartbeatDeps` (15 functions +
  2 value fields) objects defined in goal.ts, then
  `createGoalHeartbeat(heartbeatFlags, heartbeatDeps)` right after
  `createGoalRecovery(recoveryFlags, recoveryDeps)`.
- Call sites re-bound via the import: `startHeartbeat()` (5 sites),
  `upsertSubagentHangProbe` (1), `markSubagentHangProgress` (2),
  `endSubagentHangProbe` (2).

## Invariants (from the positioning doc)

- Zero behavior change: all ledger event names unchanged
  (`heartbeat_refire`, `pending_latch_stuck`, `stranded_audit_recovered`,
  `subagent_hang_detected`, `zombie_run_suspected`, …).
- No cycle: `goal-heartbeat.ts` imports nothing from `../loops/goal`.
- `grep -c 'function <moved>' extensions/loops/goal.ts` = 0 for all seven
  moved function names.
- One-way imports: new module may import goal-state, goal-loop-core,
  goal-settings, goal-loop-backoff, goal-loop, goal-recovery,
  goal-loop-dispatch (type-only) — all pre-existing decomposition modules.

## Test-pin re-anchoring (11 files)

Moved strings were re-pinned to a `HEARTBEAT_SRC`/`HB` const reading
`extensions/goal-heartbeat.ts`; pins that regex-match moved code were
re-spelled to the `flags.X` accessor form. Pins that stayed in goal.ts were
NOT weakened. Affected files:

1. `tests/stall-handling.test.ts` (12 pin sites: refire streak,
   escalation order, context-starvation gate, grace gate, stranded-audit
   watchdog, zombie watchdog, compaction debt, SUBAGENT WAIT, lifecycle
   cure messaging)
2. `tests/stale-interrupt-resume.test.ts` (heartbeatTick order pins:
   `const knownCtx = flags.lastCtx;`, `flags.extensionApiStale ||
   probeExtensionApiStaleRaw()`, `flags.compactionGraceUntil`)
3. `tests/subagent-hang-detection.test.ts` (SUBAGENT_HANG consts,
   `Symbol.for("pi-subagents:manager")`, tickBody slice — call-site pins
   `subagents:compacted/steered/completed/failed` + `upsertSubagentHangProbe`
   stay on goal.ts)
4. `tests/stale-self-heal.test.ts` (debounce const + streak guard)
5. `tests/stale-api-terminal.test.ts` (knownCtx/probe pin, v0.34.94
   self-heal region incl. `flags.staleTerminalDone = false;` +
   `flags.extensionApiStale = false;`)
6. `tests/pending-latch.test.ts` (idle/pending split, latch ledger with
   `consecutiveStalls: flags.consecutiveStalls`, wedge `sessionBusy: !idle`,
   both `escalateStallNow` call sites counted on the heartbeat file)
7. `tests/interrupt-didnt-continue.test.ts` (stranded-audit strings moved;
   `stale_revision_refused` stays)
8. `tests/stuck-audit-latch.test.ts` (Fix B stale-latch park order + exact
   stuck signature)
9. `tests/pause-informativeness.test.ts` (`${goalNoun()} appears wedged`
   moved; goalNoun sites on goal.ts still ≥10)
10. `tests/display.test.ts` (compact-debt sweep pin)
11. `tests/behavioral-orchestrator.test.ts` / `tests/host-session-lost.test.ts`
    (import re-points to `../extensions/goal-heartbeat.js`)

## Verification

- `bun test`: 1146 pass / 1 skip / 0 fail, 1147 tests across 103 files
  (run twice).
- `npx tsc --noEmit`: clean.
- Fresh-context rehearsal: PASS (4/4 checks: tsc, full suite, import
  direction, heartbeatTick migration — see rehearsal agent output).
- Contract checks: moved fn names absent from goal.ts; no
  `from "../loops/goal"` import in goal-heartbeat.ts; createGoalHeartbeat
  wired in both files; ledger event names unchanged.
