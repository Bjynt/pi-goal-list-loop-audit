# Queued-list stall reproduction — 2026-08-29

## Scope

This investigation targets the two latest field screenshots,
`Screenshot_20260828_124432.png` and `Screenshot_20260829_001635.png`, whose
OCR-visible queue surface includes `LIST QUEUED · 4 waiting`, the next queued
objective, and `/list next starts the queue`. The evidence supports what the
surface displayed; it does not by itself identify the prior goal's policy or
prove that an activation attempt was made.

No MMX visual conclusion is made here. The screenshot conclusion is limited to
the OCR-visible strings recorded above.

## Durable source/transition map

- `extensions/goal-loop-display.ts:1109-1122` renders a waiting-only
  queue as `list queued · N waiting`, names the head, and explicitly points to
  `/list next`.
- `extensions/goal-commands.ts:1400-1450` implements `/list next` as the
  explicit activation path. It resolves conflicts before calling the queue
  activation choke point.
- `extensions/loops/goal-list-queue.ts:643-774` is the activation choke
  point. It records/handles loop ownership, disk hydration, carryover,
  suspicious objectives, sidecar deletion failure, and failed goal persistence;
  successful activation removes the item and creates a list-policy goal.
- `extensions/loops/goal-orchestrator.ts:1226-1296` auto-advances only when
  the archived goal has `policy === "list"` and `status === "complete"`.
  A standalone `/goal` archive closes its goal slot but intentionally leaves
  waiting list items for explicit `/list next` consent.

## MockPi reproduction

`tests/list-stall-reproduction.test.ts` drives the real registered commands,
archive fence, queue activation, widget projection, and ledger in temporary
`.pi-glla` directories.

Command:

```text
bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/list-stall-reproduction.test.ts
```

Result: **2 pass, 0 fail**.

### Case A — screenshot-shaped waiting queue

1. Start a standalone `/goal`.
2. Add four list items with `list_add`.
3. Archive the standalone goal through the same `archiveCurrentGoal()` fence
   used after an approved completion audit.
4. Observe durable state: `goal: null`, `list.length: 4`; the status/widget
   become `LIST QUEUED · 4 waiting` and `/list next starts the queue`.
5. Observe the ledger: `goal_archived` is present and no
   `list_completion_settle_armed` transition follows it.
6. Run `/list next`; the head activates immediately, leaving three waiting
   items, without a reload.

This reproduces the screenshot-shaped surface, but the owning transition is a
standalone-goal archive, not a failed list activation. The queue is recoverable
and actionable.

### Case B — list completion cascade

1. Seed two waiting items and activate the head with `/list next`.
2. Archive the active list-policy goal through `archiveCurrentGoal()`.
3. Observe durable state: the successor is active, the queue is empty, and the
   ledger contains `list_completion_settle_armed`.

This confirms that a genuine list-sourced completion promotes its successor;
the 15-second settle window delays the successor continuation dispatch, not the
queue promotion itself.

## Disposition

No confirmed GLLA-owned queued-list stall was reproduced. No runtime source
fix is warranted by the available evidence. The exact diagnostic gap remains:
the screenshots are not linked to a durable GLLA ledger sequence that records
the prior goal policy, an activation attempt, and a blocking/failure event.
Possible blockers (load hold, active loop, suspicious objective, sidecar
cleanup, persistence, stale host, or upstream worker behavior) must not be
selected without that linkage.

The regression harness is durable and prevents the intentional standalone-goal
queue boundary from being misclassified as a silent stall. The follow-up item
must remain explicitly unresolved until a screenshot-linked or live ledger
transition identifies an in-scope owner.
