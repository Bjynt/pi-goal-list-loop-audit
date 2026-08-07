# Design — /list parallel-execution metadata (OPEN-ISSUES 1.11)

**2026-08-07** · v0.34.76 · Screenshot_20260805_095413 · "what is the
difference between list with subtasks and goal with subgoals?"

## The user question

> "what is now the different between list with subtasks and goal with
> subgoals? I guess a goal is still only one, while list is multiple"

A parallel-execution question: **if we know which list items can run in
parallel, that's the next milestone; otherwise we don't have the shape
right.** Two shapes were on the table (OPEN-ISSUES 1.11):

- **Option A — sub-goal tree**: parent + children data model, `/goal
  status` tree view, `decisions.md` carry-over, (no focus/unfocus, no
  nested children). Parked in `audit/LONG-RUNNING-MODES.md` as
  "Sub-goal tree (parent + children) — HOLD for v0.29+".
- **Option B (chosen) — parallel metadata on /list items**: the smaller
  default. Each item may carry a `parallelSafe` declaration; status
  surfaces it. Execution stays serial for now.

## Why option A stays parked (for v0.29+)

A sub-goal tree is a **structural** change: it touches the goal data
model, the status tree view, the carry-over machinery, and — the real
cost — the **activation/audit/archive lifecycle** (every node becomes an
audited goal with its own verdict). It also answers the user's question
sideways: a tree says "these goals relate", not "these can run at once".
The user's underlying need is *parallelism knowledge*, which is a
property of INDIVIDUAL work items, not of goal ancestry.

Additionally, the tree interacts badly with the current invariants:

1. **One active thing at a time** is enforced in multiple places
   (`activateNextListItem` returns false when a goal is active; the
   drafting gate refuses while a goal runs). A tree that wants parallel
   children must first relax this invariant globally — that is a
   v0.29-scale decision with wide blast radius.
2. **Auditor isolation**: every node audits independently. A parent with
   N children multiplies detached-audit traffic N-fold and raises the
   question of what "complete" means for a partially-parallel tree.
3. **No focus/unfocus yet** — a tree without focus is just a folder; the
   value of sub-goals is delegation-with-focus, which is the hardest
   part and is NOT in the parked spec.

## The chosen default (v0.34.76) — declaration only

The smaller default is a **declaration + status surface**, zero
execution change:

- **Schema**: `ListItem.parallelSafe?: boolean` (goal-loop-core.ts).
- **Marker**: a `Parallel: yes|true|1|safe|parallel|no|false|0|none|off`
  clause, line-start or inline, mirroring the `Done when:` style —
  consumed from the item text, never part of the objective or contract.
  `Parallel: no` explicitly opts out (default is undefined = unknown).
- **Parse order**: `parseListItemDeclaration` strips the `Parallel:`
  marker FIRST, then splits `Done when:` out of the cleaned text, so the
  contract never carries the declaration.
- **One enqueue path** (`enqueueItems`) + the single-item list-draft
  confirm parse the declaration; the disk sidecar (`writeQueueItemFile`
  / `readQueueFromDisk`) round-trips it, so the flag survives
  /reload and the disk-first fallback.
- **Status surface**: `/list show` and the `list_status` tool render
  `[parallel]` on declared items.
- **Execution is unchanged**: the queue still runs strictly serially.
  `parallelSafe` is data now — a parallel DISPATCHER that activates
  disjoint parallelSafe items concurrently is the next milestone, and it
  can now be built on the declaration without touching the item shape.

## Decision record

| option | cost now | value now | decision |
|---|---|---|---|
| A: sub-goal tree | data model + tree view + lifecycle/audit rework + focus question | answers "related", not "parallel" | **parked, v0.29+** (unchanged from LONG-RUNNING-MODES.md) |
| B: parallelSafe declaration | ~100 LOC + 1 marker parse | answers "can run at once" — the user's actual question | **shipped v0.34.76** |

Sub-goal tree remains the v0.29 candidate for delegation-with-focus; the
parallel metadata is orthogonal to it and neither blocks the other.
