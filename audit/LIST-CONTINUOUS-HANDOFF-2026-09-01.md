# Continuous list handoff and resume — 2026-09-01

## Scope

This follow-up addresses the new screenshot/report:
`/home/dracon/Pictures/Screenshots/Screenshot_20260901_105419.png`.
The reported behavior was that `/list next` started queued work while
`/glla resume` answered as if there were nothing resumable, leaving a visible
`LIST QUEUED` backlog waiting for a manual command.

The screenshot remains visual evidence only; it is not a durable ledger
sequence. The behavior is nevertheless GLLA-owned because both the waiting
queue projection and the resume command are implemented in GLLA.

## Root cause

Two boundaries made the report possible:

1. `archiveCurrentGoal()` auto-advanced only a completed `policy === "list"`
   item. A successful standalone `/goal` completion cleared its own slot but
   left an already-waiting list untouched, even though that list was the
   user's declared work plan.
2. `/glla resume` handled paused goals, loops, active-idle re-kicks, auditor
   recovery, and provider recovery, but did not inspect a waiting-only list.
   It fell through to `Nothing to resume` while `/list next` reached the queue
   activation choke point successfully.

The existing cold-load hold remains intentional: loading persisted work does
not start automation until explicit consent. That consent was not honored by
`/glla resume` for a queue-only state.

## Fix

- A successful standalone terminal archive now captures the pre-existing
  queue depth and, before postaudit enqueue work, invokes the existing
  `activateNextListItem()` choke point. It arms the same
  `LIST_COMPLETION_SETTLE_MS` window before scheduling the successor's first
  continuation and records `goal_completion_list_handoff` plus
  `list_completion_settle_armed`.
- `/glla resume` now hydrates queue sidecars, records `list_queue_resume`, and
  activates the waiting head when no higher-priority live goal, loop, auditor,
  or provider-recovery plane owns the surface. Activation failures remain
  loud and recoverable; suspicious objectives, loop ownership, sidecar
  deletion, persistence, and carryover fences are unchanged.
- Waiting-list status/widget copy now names `/glla resume` as the start/recovery
  action. `/list next` remains available for deliberate skip or non-head
  selection.
- User aborts still do not auto-advance. List-sourced completion keeps its
  existing archive, group-close, reviewer, and settle behavior.

## Behavioral evidence

`tests/list-stall-reproduction.test.ts` now covers:

- successful standalone completion → first waiting item active, three remain,
  handoff and settle ledger entries present;
- queue-only cold/legacy state → `/glla resume` activates the head and does not
  emit `Nothing to resume`;
- list-policy completion → successor activation and settle ledger remain
  intact.

Focused validation:

```text
npm run check
bun test --parallel=1 --max-concurrency=1 --timeout=60000 \
  tests/image1-list-stall-and-count-fix.test.ts \
  tests/list-stall-reproduction.test.ts \
  tests/list-invisible-restart.test.ts \
  tests/list-queue.test.ts \
  tests/resume-rekick.test.ts
```

Result at implementation time: **37 pass, 0 fail** across the five focused
files; TypeScript passed. The live detached-auditor path is also covered by
`tests/behavioral-orchestrator.test.ts`: **130 pass, 0 fail**, including an
approved standalone completion handing off to a pre-queued list head.

## Disposition

The prior `LIST-STALL-REPRODUCTION-2026-08-29.md` remains the historical
baseline for the old explicit-boundary behavior. This follow-up closes the
GLLA-owned gap: once a successful goal has a waiting list behind it, the list
now proceeds without `/list next` between items, and an explicit `/glla resume`
can release a waiting-only queue after restore.
