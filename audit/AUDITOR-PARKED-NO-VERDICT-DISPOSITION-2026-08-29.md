# Auditor parked/no-verdict disposition — 2026-08-29

## Scope

This closes the GLLA-owned parked/no-verdict recovery review. It validates the
current fallback, bounded retry, durable cursor, infrastructure classification,
and manual-recovery paths against the reported detached-auditor failure. It does
**not** claim that the separate zero-stream queued-list stall is fixed; that
incident still needs a reproduction and owning ledger transition.

## Disposition

**GLLA recovery machinery is validated; no additional source change is warranted
from this review.** Provider availability, credentials, quota, and upstream
worker/provider behavior remain external reliability conditions. GLLA records
those conditions as infrastructure failures and preserves a recoverable stored
completion claim rather than treating them as an auditor approval or a goal
success.

## Current-main evidence

- `extensions/goal-loop-auditor-process.ts:41-90` defines the concrete
  infrastructure classes (`no-verdict`, `timeout`, `transport`, `provider`) and
  `normalizeAuditorInfrastructureResult()` supplies a concrete fallback error
  when a worker returns no verdict/error.
- `extensions/loops/goal-auditor-hooks.ts:547-632` parks a paused stored claim
  for recovery, retains the conservative recovery envelope, and only admits a
  matching durable retry record.
- `extensions/loops/goal-auditor-hooks.ts:634-663` makes a manual retry after
  `auditorFallbackExhausted` a fresh cycle by clearing the persisted candidate
  cursor and retry-start marker before dispatch.
- `extensions/loops/goal-auditor-hooks.ts:735-824` bounds automatic retries to
  five attempts, uses the eager five-second first probe, and supports the
  event-driven aggressive recovery path without depending on provider-family
  guesses.
- `extensions/loops/goal-auditor-hooks.ts:860-883` persists sanitized candidate
  references and fails closed when cursor persistence cannot be completed.
- `extensions/loops/goal-auditor-hooks.ts:940-1183` fences retry start before
  the second provider call, consumes an unknown-start cursor after restart, and
  keeps `fallbackExhausted` distinct from the infrastructure class.

## Durable ledger evidence

The raw `.pi-glla/active.jsonl` ledger contains the expected recovery sequences,
including:

- 88 `audit_recovery_started` events, 86
  `audit_recovery_auto_retry_claimed` events, 68
  `audit_recovery_retry_scheduled` events, and 67
  `audit_recovery_retry_due` events;
- 57 `audit_infra_retry` and 39
  `audit_no_verdict_infrastructure` events, showing that infrastructure
  outcomes are durably distinguished from verdict outcomes;
- provider and timeout diagnostics, including the 429 weekly-limit report and
  `Auditor stalled — tool bash exceeded its 5m timeout; the detached job was
  auto-cancelled.`;
- after timeout recovery, fresh `audit_started` events are recorded rather
  than an implicit approval or an unbounded same-candidate replay. For example,
  goal `20260829094535-bfgeol` has the timeout at
  `2026-08-29T11:49:43.632Z`, while the next reviewed goal's detached attempt
  is separately recorded at `2026-08-29T13:02:57.038Z`.

These counts demonstrate active durable recovery machinery, not proof that the
historical list-stall screenshot has been reproduced or eliminated.

## Verification

Focused command:

```text
bun test --parallel=1 --max-concurrency=1 --timeout=60000 \
  tests/auditor-fallback-unification.test.ts \
  tests/auditor-eager-retry.test.ts \
  tests/auditor-error-paths.test.ts \
  tests/auditor-process.test.ts \
  tests/persistence-hardening.test.ts \
  tests/recovery-restore-after-restart.test.ts \
  tests/lifecycle-recovery.test.ts \
  tests/stale-api-terminal.test.ts
```

Result: **101 pass / 0 fail across 8 files** (`24.05s`). The covered cases
include fallback ordering and exhaustion, eager and bounded retry timing,
no-verdict/timeout/transport/provider normalization, cursor persistence and
restart fencing, lifecycle recovery, and stale API terminal handling.

No source files were changed for this review. The detached completion auditor's
independent approval remains the final closure gate for the active goal.
