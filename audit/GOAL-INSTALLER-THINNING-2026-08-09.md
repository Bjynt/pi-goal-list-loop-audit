# Goal installer thinning (v0.34.114)

Date: 2026-08-09
Version: v0.34.114
Scope: decomposition step 6 from `docs/GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md`

## What changed

`extensions/loops/goal.ts` is now the real public activation/wiring surface,
not a façade over a renamed monolith.

The historical 7,054-line post-v0.34.113 runtime was split into named concern
modules under `extensions/loops/`:

- `goal-session.ts` — session identity, stale runtime detection, owner/handoff
  files, foreign-context guards, drafting/session state.
- `goal-ui.ts` — activity accounting, UI refresh/ticker, compaction/context
  starvation state, test hooks.
- `goal-orchestrator.ts` — stall escalation, session-owned timers, goal
  creation/persistence, active-goal mutation, archive/list-fanout machinery.
- `goal-auditor-hooks.ts` — completion-audit validation, detached auditor
  fallback/retry, quota retry planning, reviewer fire path.
- `goal-list-queue.ts` — queue/group activation, list drafting, notify/stale
  tool helpers.
- `goal-tools.ts` — agent-tool registration and execute handlers.
- `goal-settings-ui.ts` — auditor model resolution, settings picker/editor,
  model-change observers.
- `goal-activation.ts` — command registration and pi lifecycle/event handlers.
- `goal-runtime-globals.ts` — narrow compatibility bridge that exposes the old
  monolith lexical links as explicit runtime globals while the concern modules
  are split; this keeps moved bodies behavior-preserving without importing
  back from `goal.ts`.

`goal.ts` now contains the composition/wiring block itself, including the real
`createGoalContinuation(continuationFlags, continuationDeps)` call required by
the contract. The default export captures the fresh `ExtensionAPI`, resets the
length-continue tracker, starts heartbeat/UI ticker, and delegates registration
to `goal-activation.ts`.

There is no `extensions/loops/goal-runtime.ts` monolith.

## Line-count contract

Before v0.34.114:

- `extensions/loops/goal.ts`: 7,054 lines after the v0.34.113 continuation
  extraction.

After v0.34.114:

- `extensions/loops/goal.ts`: 387 lines.

The step-6 verifier's hard line-count contract (`wc -l extensions/loops/goal.ts
≤ 700`) is satisfied.

## Import and behavior invariants

- Import direction stays one-way: runtime concern modules do not import from
  `extensions/loops/goal.ts`.
- The real continuation wiring remains in `goal.ts` via
  `createGoalContinuation(...)`.
- Default export behavior and named test-hook exports remain available through
  `extensions/loops/goal`.
- Ledger event names are unchanged; event emission call sites moved with their
  owning concern modules.
- Existing extracted modules remain in place (`goal-state.ts`,
  `goal-commands.ts`, `goal-loop.ts`, `goal-recovery.ts`, `goal-heartbeat.ts`,
  `goal-continuation.ts`).

## Source-pin re-anchoring

Source-pinned tests now read a live source corpus helper
(`tests/harness/goal-source.ts`) that concatenates `goal.ts` plus the extracted
runtime concern modules. This preserves the old source-pin expectations against
real source files without adding a production monolith. Two strict-mode callback
pins were mechanically widened to accept the required split-module type spelling
`(fresh: ExtensionContext) =>`.

## Verification

Commands run after the real split and source-pin re-anchor:

```bash
npx tsc --noEmit
timeout 180 bun test
```

Results:

- TypeScript: no errors.
- Tests: 1146 pass / 1 skip / 0 fail (1147 tests across 103 files).
- `wc -l extensions/loops/goal.ts`: 387.
- `grep -c 'createGoalContinuation' extensions/loops/goal.ts`: > 0.
- `test ! -e extensions/loops/goal-runtime.ts`.
