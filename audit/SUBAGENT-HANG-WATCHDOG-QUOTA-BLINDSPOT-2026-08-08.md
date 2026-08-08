# SUBAGENT-HANG-WATCHDOG-QUOTA-BLINDSPOT (v0.34.105)

Field-validated bug found by a LIVE audit (the audit subagent itself died
mid-run — which is the subject of this fix).

verification: bun test tests/subagent-hang-detection.test.ts → 15 pass / 0 fail; full suite 1142 pass / 1 skip / 0 fail; npx tsc --noEmit clean; version 0.34.105.

## Field case (2026-08-08 ~16:18)

A general-purpose audit subagent (id 74305f7e, 279 tool uses into the
job) hit the MiniMax Token-Plan quota wall:

```
16:18:09 assistant stopReason=error
429 {"type":"error","error":{"type":"rate_limit_error",
    "message":"The Token Plan usage limit has been reached...
    (2067)"}}
```

The subagent froze with zero further events. Meanwhile the MAIN model was
ALSO in recovery — the ledger shows 18 `main_model_recovery_wait`
entries (attempts 1–4, retryAt hourly). This is exactly the
shared-provider-wall shape: the same quota wall freezes the main model
and every subagent on that provider at the same time.

## Root cause

`heartbeatTick` runs the subagent hang scan (v0.34.85) at the END of its
body, but an early gate `if (mainModelRecoveryActive()) return;`
(line ~2176) exited the heartbeat BEFORE the scan when the main model
was quota-parked. Result: a subagent frozen for 12+ minutes produced
ZERO `subagent_hang_detected` ledger entries and no user warning —
the watchdog was blind precisely when it mattered most.

## Fix

Moved the entire subagent hang scan ahead of the
`mainModelRecoveryActive()` gate in `heartbeatTick`. The scan is
detection + notify only (never an auto-kill, never a send) — safe to
run while the main model is parked. Evidence classes (v0.34.102) are
unchanged: `record-frozen` vs `event-only`.

## Tests

- Behavioral regression: parks the main model via 3× 429 `agent_end`
  turns, freezes a subagent record (6m no progress), drives one
  `__testOnlyHeartbeatTick`, asserts `subagent_hang_detected` fires
  with `evidence: record-frozen` and a user warning lands.
- Source pin: the subagent scan (`subagentHangProbes.size > 0`) appears
  BEFORE the `mainModelRecoveryActive()` early return inside
  `heartbeatTick`.

## Ship

- version 0.34.105, CHANGELOG entry, tag v0.34.105, symlink
  v0.34.105-SUBAGENT-HANG-WATCHDOG-QUOTA-BLINDSPOT.md →
  SUBAGENT-HANG-WATCHDOG-QUOTA-BLINDSPOT-2026-08-08.md,
  this doc carries the literal `verification:` marker.
