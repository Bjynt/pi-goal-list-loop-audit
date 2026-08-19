# Audit policy controls — 2026-08-19

**Status:** policy review and implementation boundary; no source change is
supported by this review.

**Note on the Designer subagent:** the Designer is an opt-in read-only
subagent (`Agent(designer)`), not a default step. This review mentions a
Designer review as one transient evidence sample; its considerations are
advisory and are not load-bearing for the policy contract. When the Designer
agent is not selected, its suggestions must be ignored — the contract stands
on the typed configuration, the source-code references, and the focused
regression tests, not on a Designer draft.

## Decision summary

The word **audit** names three different operations in this project. They must
not share one ambiguous switch:

1. **Completion verification** — the detached auditor checks a `complete_goal`
   claim before a goal is archived or a list advances.
2. **Postaudit** — the deterministic reviewer runs after a terminal completion,
   mines curated auditor reports, and may queue or propose follow-up work.
3. **Project audit** — `/goal audit`, `/list audit`, and `/loop audit` are
   explicit project-wide audit workflows with different ownership and finish
   lines.

The requested four-mode cadence belongs to **automatic postaudit scheduling**:

- `none` — no automatic postaudit;
- `completion-only` — run it at the configured completion boundary;
- `every-n-tasks` — run it after N completed tasks;
- `periodic` — run it no more often than a configured wall-clock interval.

`none` must mean *no automatic follow-up review*, not silent bypass of the
completion verifier. A user may still request `/goal verify`, `/review`,
`/goal audit`, `/list audit`, or `/loop audit` explicitly. The safe default is
`completion-only`, preserving the current completion-triggered behavior.

## Current implementation

The current code already has most of the ownership boundaries, but not the
four-mode scheduler:

| Surface | Current behavior | Cadence implication |
| --- | --- | --- |
| `complete_goal` | Starts a detached completion auditor for every active goal, including a list item. | This is the evidence gate; it is not controlled by `postaudit`. |
| `/goal verify` | Starts the detached auditor immediately for the current goal, without an agent turn. | Explicit verification overrides automatic cadence. |
| `/goal audit` | Creates one normal audit goal that performs one project pass and fixes `FIX` findings. | Explicit one-shot project audit; its own completion still follows the evidence gate. |
| `/list audit` | Queues a collection item; completion fans open findings into separately audited fix items. | Explicit collect-then-drain workflow; it is not a cadence timer. |
| `/loop audit` | Runs the fix-first findings loop and measures closed `FIX` boxes. | Independent metric loop; it has no detached auditor per iteration. |
| `/loop` (ordinary) | Uses its numeric/spec metric and does not invoke the postaudit reviewer. | Loop iterations are not tasks for a postaudit counter. |
| `postaudit` / `reviewer` | Fires on `goal-complete` and, when the queue empties, `list-complete`; `off/on/auto/aggressive` controls cascade behavior. | `fireOn`, refire-window, and daily cap are guards, not cadence modes. |

Relevant implementation points are `complete_goal` in
`extensions/loops/goal-tools.ts`, `cmdGoal` in `extensions/goal-commands.ts`,
`listAuditCollectTarget` and `auditTarget` in
`extensions/goal-loop-forever.ts`, `archiveCurrentGoal` in
`extensions/loops/goal-orchestrator.ts`, and `runReviewer` in
`extensions/reviewer.ts`.

The existing `ReviewerConfig.auditCadence` string is descriptive configuration
only: `runReviewer` does not interpret it. The default label
`every-clean-completion` therefore must not be presented as support for
N-task or wall-clock scheduling. `auditCap` is a consecutive-disapproval cap,
not an audit cadence. Auditor retry timers are recovery controls, not scheduled
project audits.

## Confirmed gap

None of the four modes is currently a configurable scheduler:

- `complete_goal` always starts the detached completion auditor at its normal
  dispatch site; the only no-audit path is the explicit Escape confirmation to
  complete without audit.
- `completion-only` is the de-facto default, not a named setting.
- `every-n-tasks` has no durable completion counter.
- `periodic` has no durable `lastRunAt`/`nextDueAt` or wake-up scheduler.
- `postaudit.auditCadence` is declared and defaulted but has no runtime read,
  and `/glla postaudit` exposes no cadence editor.

These are confirmed design gaps, not a license to infer a bug from the dead
field. The requested deliverable is the policy contract below; implementing a
scheduler is a separate feature and must preserve the current detached
completion-verifier and recovery tests.

## Cadence contract

A future typed project setting should normalize the existing free-form field
rather than silently interpreting arbitrary strings. The minimum shape is:

```text
postaudit.cadence: "none" | "completion-only" | "every-n-tasks" | "periodic"
postaudit.everyNTasks: positive integer, required for every-n-tasks
postaudit.periodMinutes: positive integer, required for periodic
postaudit.scope: "goal" | "list" | "both" (default: both)
```

This setting governs automatic postaudit follow-up, not the detached
completion-verification gate. The latter remains every `complete_goal` claim
by default and is only bypassed through a separately explicit operator choice;
otherwise a cadence throttle would turn a task-completion preference into an
unchecked archive policy.

Invalid or incomplete values fall back to `completion-only` with a warning
and a ledger entry; they must never disable verification accidentally. A
migration maps the legacy `every-clean-completion` label to
`completion-only`.

### `none`

Do not invoke automatic `fireReviewer` after a completion. Do not fabricate a
review report or mark a missed review as clean. Explicit `/review` remains
available for an archived goal, and explicit project audit commands remain
available. The detached completion auditor still protects `complete_goal`.

Changing into `none` resets the automatic scheduler's pending counter and due
marker, with the change recorded. Re-enabling a cadence starts a new window;
it does not replay an unbounded backlog of old completions.

### `completion-only`

Run one postaudit at the selected completion boundary. A non-list goal counts
when it is archived `complete`. A list task counts when its child goal is
archived `complete`; queue exhaustion may additionally produce the existing
list-level completion notification, but must not be the only way to observe a
configured per-task cadence. Aborts, pauses, impossible outcomes, and rejected
claims do not count as successful completions.

The existing `fireOn` setting remains a scope filter. The cadence must not
silently turn `goal-complete` or `list-complete` back on after the user disabled
that boundary.

### `every-n-tasks`

Count successful completed objectives in the configured scope since the last
successfully dispatched postaudit. Count each list child once; do not count a
loop iteration, an aborted item, or a task that is still awaiting its detached
completion verdict. At N, persist a single due record and coalesce concurrent
completion events into one review. Reset the counter only after the review
trigger is durably accepted; a failed trigger leaves the due work recoverable.

A task count is project-scoped and survives a Pi restart in `.pi-glla` state or
ledger. It is not inferred from conversational text or from old archive prose.

### `periodic`

Persist `lastRunAt`, `nextDueAt`, and a schedule generation. The scheduler may
check the deadline at lifecycle boundaries and successful task completion, but
must not require a permanently running timer. If several periods elapsed while
Pi was closed, coalesce them into one overdue review; never launch a burst of
catch-up audits. Advance `nextDueAt` only after the trigger is durably
accepted. A cadence edit starts a new generation and does not inherit an old
schedule accidentally.

Periodic postaudit is not the same thing as `/loop audit`: the latter is an
explicit, continuously working metric loop. Running both should produce a
clear stack warning or an explicit user choice, not two silent audit owners.

## Goal, list, and loop interactions

### Goals

A goal's completion claim is first-class durable state. The cadence scheduler
must run only after the detached completion verdict has approved the current
revision and the archive has landed. A disapproval returns the work to the
agent; an impossible verdict pauses it; a stale or missing verdict never counts
as a completion. This prevents a postaudit schedule from becoming a second,
weaker completion gate.

`/goal verify` is an explicit audit request even under `none`. It audits the
current contract and is subject to the same revision fence and unavailable-
auditor recovery as `complete_goal`.

### Lists

A list item is a goal with `policy: "list"`. Therefore each item uses the
completion verifier and must not be silently advanced when that verifier has
no verdict. Queue exhaustion is a separate list-level event: current
postaudit fires there by default, while a future `completion-only` cadence may
choose item-level or queue-level scope explicitly. The policy should expose
that choice instead of making `list-complete` appear to mean every task.

`/list audit` is an explicit collection item. It changes no code during
collection; its fan-out queues open `FIX` findings, presents `DECIDE` findings,
and each resulting fix is independently audited. Automatic cadence must not
mine or duplicate the collection item's own objective text.

### Loops

A normal `/loop` iteration is not a completed task and must not increment an
N-task counter. `/loop audit` owns a different metric (`closed FIX` findings)
and has no detached auditor per iteration; the measure and loop bounds are its
verdict. A loop stop/finish does not implicitly invoke postaudit under the
current behavior. If a user wants a project audit after a loop, they use an
explicit command or enable a separately documented loop-boundary policy; the
scheduler must never infer this from an arbitrary loop target.

`aggressiveMode`, `autoResume`, and postaudit `mode` remain orthogonal:
recovery/queue continuation may be aggressive, while cadence still determines
*when* a review is due. `auto` and `aggressive` change whether follow-up work
is queued or relaunched; they do not authorize a hidden audit when cadence is
`none`.

## Auditor unavailable

There are two failure classes and they must remain separate.

### Detached completion auditor

A worker exit, timeout, malformed result, stale host, unavailable model, or
missing verdict is infrastructure, not approval or disapproval. The claim
stays in `pendingCompletion`; the goal is paused with an honest no-verdict
reason, and the bounded model/recovery path may retry it. The queue does not
advance and no postaudit cadence counter is consumed. A fresh lifecycle or
explicit `/goal resume` / `/list resume` can retry the stored claim. When the
bounded recovery horizon ends, the claim remains inspectable and requires an
explicit new bounded window; it is never auto-completed.

### Postaudit trigger or reviewer

The reviewer itself is deterministic and makes no model/tool calls. If its
write, enqueue, proposal delivery, or host context fails, the already-approved
completion remains terminal; the failure must be visible as a warning and
ledgered as a missed trigger, never reported as a clean audit. The persisted
counter/due marker remains pending so a later healthy lifecycle can retry one
coalesced review. A failed `/goal` proposal is not counted as proposed, and a
failed queue enqueue is not counted as enqueued.

If the project audit collector cannot finish, `/list audit` must leave its
collection item and findings state recoverable; it must not fan out an empty
queue. If `/goal audit` cannot obtain its completion verdict, it follows the
same stored-claim pause/retry path. `/loop audit` treats provider, command, or
measure failure as no measured progress and applies its existing backoff and
bounds; it must not invent a closed-finding increment.

## Defaults and migration

- Default cadence: `completion-only`, scope `both`, with the current conservative
  `postaudit` mode `on` and daily/refire guards intact.
- Default completion verification: every `complete_goal` claim, unchanged by
  postaudit cadence.
- Default loop behavior: no automatic postaudit per iteration.
- `postaudit.mode = off` remains a compatibility alias for automatic cadence
  `none`; it must not disable explicit `/goal verify` or project audit commands.
- `postaudit.auditCadence = every-clean-completion` migrates to
  `cadence = completion-only`. Unknown values warn and fall back to
  `completion-only`.
- Cadence changes are project-scoped policy changes. Show effective source and
  schedule state in settings/status; never promote a sentence from a goal,
  auditor report, repository file, or Explore transcript into this setting.

The existing implementation already provides the safe completion-verifier and
recovery behavior. It does not yet persist an N-task/periodic scheduler or
interpret `auditCadence`; implementing those would be a separate bounded
feature with tests for counters, coalescing, restart recovery, and failure
retry. This review therefore records the contract without pretending that
those modes are already shipped.

## Evidence reviewed

- `extensions/loops/goal-tools.ts`: `complete_goal` persists the claim before
  launching the detached auditor; Escape offers an explicit complete-without-
  audit choice; no ordinary silent bypass exists.
- `extensions/loops/goal-auditor-hooks.ts`: approved claims archive, while
  no-verdict infrastructure preserves the claim, pauses, and schedules bounded
  recovery; `fireReviewer` treats follow-up failure as non-fatal and loud.
- `extensions/goal-commands.ts`: `/goal verify`, `/goal audit`, and `/list
  audit` are explicit surfaces with separate semantics.
- `extensions/loops/goal-orchestrator.ts`: list advancement waits for a
  completed list goal and the reviewer fires on queue-empty `list-complete`.
- `extensions/goal-loop-forever.ts`: `/loop audit` measures closed `FIX`
  findings; `/list audit` fan-out excludes `DECIDE` findings from the queue.
- `extensions/reviewer.ts`: current `ReviewerConfig`, four cascade modes,
  refire window, daily cap, and unused `auditCadence` field.
- Focused regression coverage includes `tests/reviewer-modes.test.ts`,
  `tests/postaudit-surface.test.ts`, `tests/retry-bounds.test.ts`,
  `tests/behavioral-orchestrator.test.ts`, and `tests/display.test.ts`.

**Conclusion:** the safe, backwards-compatible policy is
completion-triggered postaudit by default, explicit opt-out for automatic
follow-up only, and no weakening of the detached completion evidence gate.
N-task and periodic modes are clearly specified as future scheduler modes
rather than being falsely claimed as current behavior. This review defines the
contract; it does not claim that the dead `auditCadence` field already wires
those modes into runtime behavior.
