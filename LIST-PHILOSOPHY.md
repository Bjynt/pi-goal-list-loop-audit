# List philosophy — the three-mode hierarchy

pi-goal-list-loop-audit ships three loops. They are NOT redundant — each
has a **distinct source of long-running-ness**:

| Mode | Item size | Long-running by | Typical lifetime |
|---|---|---|---|
| `/goal` | ONE big multi-hour task | **Scope** | Hours |
| `/list` | N items × short (minutes each) | **Queue depth** | Hours → days → weeks |
| `/loop` | 1 metric × infinite polish | **Bounds** | Until plateau/stop/finish |

## `/goal` — one big long task

`/goal` is the multi-hour mode. Its long-running property is **scope**:
one task that spans multiple agent runs, requires deep research, or would
take hours end-to-end. It ends only when the isolated auditor approves
the verification contract. If your work fits in a single agent run — a
focused change, one audit, a small refactor — it belongs in `/list`.

## `/list` — hundreds of short items

`/list` items are **short tasks, not multi-hour objectives**. Each item
should fit comfortably in a single agent run: minutes of work, a single
focused change. The list's long-running property is **queue depth** — the
queue can hold hundreds of items, activated one at a time, pushed over
days or weeks. An item longer than ~30 minutes probably wants breaking
up; much longer and it wants `/goal`.

`/list depth` shows the long-running state: queue depth, oldest item age,
and average item duration from your archived list items.

## `/loop` — metric-driven infinite polish

`/loop` improves ONE metric forever. Its long-running property is
**bounds**: it ends on plateau, on bounds (max iterations / time /
tokens), on `/loop stop`, or on `/loop finish` (graceful stop after the
current iteration).

## The wrapper-goal anti-pattern (why this doc exists)

Real incidents, 2026-07-24, two projects on the same day:

> "Close every weak point in `docs/per-screen-weak-points.md` (76 items,
> one commit each)" and "land all 40 findings as a tasklist, ordered by
> ROI" — each folded into **ONE** list item with an **aggregate**
> verification contract ("≥ 76 commits with `CLOSED:`", "≥ 32 fix(Wn)
> commits").

The work got done; the auto-committer squashed intermediate commits; the
literal commit count failed; the isolated auditor **correctly
disapproved** finished work. The failure was at step 1 — task
designation — not at the audit.

The fix: **N independent short items → N `/list` items**, each closing
exactly ONE finding with its own per-item contract ("close IMP-AUD3-68:
`Map.svelte:1528` missing `role`"). Per-item contracts are impossible to
squash. Any aggregate re-audit becomes the FINAL `/goal`, not the first.

Since v0.25.3 the drafting flow detects this shape ("N items" + "each" +
"one commit") and steers you to `items[]` — see the cross-recommend
block in `prompts/goal-loop-draft.md`.

Since v0.26.0 the **Reviewer** is the post-completion glue layer across
all three modes' terminal states: it converts completion findings into
`/list` items (bug/refactor, no Confirm), proposes architectural work as
`/goal` (Confirm), fires a regression-scan audit on clean completions,
and notifies + idles otherwise. See `INSTALL.md` "Reviewer".

## Audit Cadence: Why Every `/list` Task is Audited

Auditing occurs at the completion boundary of **every single `/list` task** (via the detached isolated auditor) before the next item in the queue can activate.

While auditing every item requires rigorous verification, it prevents **queue drift**:
- In a 50-item list, an unverified error in item #2 would otherwise silently corrupt the codebase, causing items #3 through #50 to fail or build on broken invariants.
- Per-task auditing ensures each item represents a rock-solid, verified invariant before the next task begins.

## Single-Trunk Execution Law & Parallelization

### Why "Main-Only" Outperforms Branch Swarms in Autonomous Loops
Speculative feature branching across autonomous subagents creates **stale context bubbles** and **merge collision debt**:
1. Agent A on branch-1 and Agent B on branch-2 both read from snapshot $T_0$.
2. Once Agent A lands a commit, Agent B is working on an obsolete codebase without knowing it.
3. Merging parallel LLM branches frequently causes semantic regressions and broken invariants.

### The Single-Trunk Operating Rule:
* **Serial Queue on `main`**: All queue items drain sequentially on the single primary working tree. Item $N+1$ always executes with 100% truthful, up-to-date context left by item $N$.
* **Transactional Green-or-Revert**: Every task either lands green (verified by tests and the detached auditor) and commits, or cleanly rolls back on `main` before the next backlog item is touched.
* **Safe Subagent Parallelism**: Subagents are used for **read-only research fan-out** (e.g. concurrent `Explore` queries across subsystems in a single turn) or standalone verification, rather than speculative mutating branches.

See `INSTALL.md` for the command surface.
