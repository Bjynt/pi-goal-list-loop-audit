# Host session lost — 2026-08-10 follow-up

## Finding

The new note screenshots (`Screenshot_20260810_043223.png` and
`Screenshot_20260810_043341.png`) show two adjacent failure modes, not one
plugin bug:

1. **Accepted continuation, no turn start.** The enqueue accepted a
   continuation, but no observable `before_agent_start`/turn-start proof
   arrived. glla's safe response is to stop blind re-sends and keep the work
   in `.pi-glla/`; `/list resume`, `/goal resume`, or `/loop resume` is an
   explicit one-attempt retry.
2. **Stale host handle.** The old extension context was invalidated and no
   replacement event was delivered at that moment. The live objective is
   marked interrupted and waits for a fresh session boundary.

MMX vision identified the screenshot surface and attributed the stale-handle
and subagent/terminal status grammar to the host bridge context; the plugin
owns the warning and durable park, but not pi's ability to create or deliver a
replacement session.

## Raw field correlation

The capture-anime-girls project ledger at
`/home/dracon/Dev/dracon-platform/web/games/wip/capture-anime-girls/.pi-glla/active.jsonl`
contains the matching sequence:

```text
2026-08-10T03:22:49.858Z  continuation_dispatch_accepted
2026-08-10T03:25:19.859Z  continuation_start_unacknowledged
2026-08-10T03:32:29.438Z  extension_api_stale (heartbeat probe)
2026-08-10T03:32:29.438Z  session_handle_invalidated reason=silent_handle_death
2026-08-10T03:36:29.221Z  session_shutdown reason=reload
2026-08-10T03:36:30.488Z  session_rebound reason=reload
2026-08-10T03:36:30.617Z  continuation_dispatch_recovered
2026-08-10T03:36:30.621Z  session_handoff_rejected reason=identity-mismatch
2026-08-10T03:36:30.809Z  replacement continuation start acknowledged
```

This confirms that the stale event preceded the later manual reload boundary;
it was not a clean shutdown/rebind pair at the time of loss. The recovered
replacement subsequently started successfully.

## Current glla behavior

- `extensions/goal-continuation.ts` uses a bounded 30-second first start-proof
  window plus exactly one 60-second verbatim retry; then it records
  `continuation_start_unacknowledged` and holds automatic sends.
- `extensions/goal-session.ts` classifies the observed no-boundary case as
  `silent_handle_death`, preserves the interrupted objective, and tells the
  user to use `/new` for a cached stale context.
- `extensions/goal-heartbeat.ts` can self-heal only when its raw API probe
  proves pi has already recovered; it cannot manufacture a new pi session or
  invoke pi's private event dispatch.
- `extensions/goal-loop-display.ts` separates “turn start not observed” from
  “host session lost”; it does not label the former as a stale handle.
- `tests/host-session-lost.test.ts`, `tests/stale-api-terminal.test.ts`,
  `tests/behavioral-orchestrator.test.ts`, `tests/display.test.ts`, and
  `tests/fresh-session-auto-recovery.test.ts` cover the classification,
  bounded retry, durable park, truthful `/new` guidance, and self-heal gate.

The prior screenshot text that suggests `/reload` is historical/stale relative
to current glla display copy. `/reload` can work only when pi emits a proper
lifecycle boundary; it does not clear pi's cached context. Automatic recovery
for a true stale event-context loss remains a pi-side API limitation until pi
exposes a safe session-replacement action to event handlers.

## Verification

```text
mmx vision describe — both screenshots inspected
capture-anime-girls ledger — raw sequence above
current source — 30s + one 60s retry; stale display says /new
bun test tests/host-session-lost.test.ts tests/stale-api-terminal.test.ts \
  tests/fresh-session-auto-recovery.test.ts tests/display.test.ts
# 113 pass / 0 fail across 4 files
npx tsc --noEmit
# TypeScript: No errors found
```

This follow-up made no plugin code change because the remaining
automatic-recovery gap is host-owned.
