# UI repaint and auditor prompt-boundary audit — 2026-08-31

## Scope

This follow-up rechecked the current GLLA checkout after the v0.36.1 release,
with emphasis on durable state visibility, prompt data boundaries, release
hygiene, and transferable Codex-style practices. It changed only GLLA source,
tests, changelog, and repository audit evidence.

## Findings and fixes

### Durable UI state could be throttled away

The v0.36.2 UI cadence change put the two-second render guard before state
projection. Because `refreshUI` is called by durable transitions, a recent
activity repaint could suppress a newly persisted queue, audit, pause, or
recovery surface. The cross-context cache fix handled replacement first paint,
but same-context durable transitions still remained stale.

`refreshUI(ctx, true)` now bypasses only the cadence gate while retaining the
status/widget diff guard. The persistence choke point, deferred settle repaint,
startup/rebind paths, stale-host recovery, and immediate audit state changes use
the forced path. The five-second ticker and ordinary activity refresh remain
bounded and diff-aware.

### Auditor payload boundaries were not escaped

The detached completion-auditor prompt placed `renderGoalMarkdown(goal)`, the
executor summaries, the verification contract, and prior shield gaps inside
XML-like blocks without escaping `<`, `>`, or `&`. A goal or model-authored
report containing a closing tag could therefore make the data boundary
ambiguous to the auditor model.

The prompt now escapes those payloads as XML text and explicitly labels the
encoded values as untrusted data. The structural tags and the existing
terminal-line verdict, raw-evidence shield, scope guard, and detached process
protocol are unchanged.

## Codex-informed lessons

The useful transferable pattern is boundary clarity: state the outcome and
evidence contract explicitly, keep untrusted payloads separate from control
instructions, and preserve a compact durable checkpoint rather than relying on
ambient context. GLLA already has stronger detached auditing, owner/generation
fences, consent gates, and recovery state; this pass adopts only the narrow
payload-escaping lesson and does not import another project's storage or
startup-resume behavior.

## Verification

- `bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/behavioral-orchestrator.test.ts`: 127 passed.
- `bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/list-stall-reproduction.test.ts`: 2 passed.
- `bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/durable-defer-production-ui.test.ts`: 1 passed.
- `bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/display.test.ts tests/goal-state.test.ts`: 109 passed.
- Full `npm run test:all`: 1,772 passed, 1 skipped, 0 failed across 168 files; Jiti and offline auditor-extension checks passed.
- The auditor payload regression test is included in the next full release-gate run.
- No Pi core, operating-system, provider, `pi-subagents`, or other-plugin files were changed.
