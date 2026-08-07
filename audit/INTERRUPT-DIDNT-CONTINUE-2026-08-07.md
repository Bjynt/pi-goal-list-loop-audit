# Interrupt didn't continue — ledger timeline, root cause, fix

**2026-08-07** · v0.34.74 · `Screenshot_20260807_100610.png` · project: junk-runner
(`~/Dev/dracon-platform/web/games/wip/junk-runner`)

## The complaint

"Interrupt didn't continue" — after an interrupt, the goal/list went quiet
instead of continuing. The screenshot (10:06:10) shows the list item for goal
`20260806215307-4irtlm` (Comms inbox integration) parked:

```
└─ completion audit interrupted — no verdict
└─ awaiting first turn — resumes exactly here
└─ The completion attempt was not evaluated. /list resume returns to the work…
```

plus two warnings:

1. **"Stale auditor verdict REFUSED: goal 20260806215307-4irtlm revision is 0
   but the auditor captured 0. The goal moved on during the audit — its
   verdict was not applied. Run /goal verify again to audit the current
   state."**
2. **"Completion audit interrupted — no verdict. MAIN released; /list resume
   to continue."**

## Ledger timeline (`.pi-glla/active.jsonl`, goal `20260806215307-4irtlm`)

```
08-06 21:53:07  goal_created (Comms inbox integration)      continuation sent
08-07 01:25:22  audit_started  attempt audit-msi9ja33-7qqy6h   → status auditing
08-07 01:44:00  audit_recovery_pending  reason:"session_shutdown:quit"
                → the USER QUIT pi mid-audit; goal paused
08-07 01:44:08  goal active → auditing; audit_started attempt audit-msia7eeo-bgii24
                (restart recovery dispatched a FRESH detached audit)
08-07 01:47:25  stale_revision_refused  attempt audit-msia7eeo-bgii24
                → warning 1 (verdict NOT applied)
08-07 01:47:36  stranded_audit_recovered  via:"resume-active"
                → goal paused "completion audit interrupted — no verdict"
                → warning 2
… 7h33m of silence (no auto-resume, no continuation) …
08-07 09:06:35  goal active again — the user manually resumed (/list resume)
08-07 09:08:36  audit_started attempt audit-msiq2zo9-irc4vl
08-07 09:13:04  goal_archived COMPLETE
```

The goal's revision was `None` (never set) at every state line. The refusal
occurred even though **both displayed revisions are 0**.

## Root-cause hypothesis (code-verified)

**Bug A — spurious stale-revision refusal for never-set revisions.**
The v0.34.61 focus-revision guard at `retryStoredCompletionAudit`
(extensions/loops/goal.ts ~3786) compared the goal's raw revision against the
auditor's captured one:

```ts
if (result.goalRevision && state.goal.revision !== result.goalRevision.revision) {
```

The goal model's `revision?` is optional; goals created before/without a bump
carry `undefined`. The auditor captures `{revision: goal.revision ?? 0}` (=
0). So the guard ran `undefined !== 0` → **spurious refusal** for a goal
whose contract had NOT moved. The warning message interpolates `?? 0` on both
sides, so it reads "revision is 0 but the auditor captured 0" — visibly
contradictory, which is exactly what the user saw. The canonical normalized
check `isGoalRevisionCurrent` (goal-loop-core.ts:1084, `current?.revision ??
0 === captured.revision`) already existed and was tested — the guard simply
didn't use it.

**Bug B — the refusal left the goal in a non-actionable dead end.**
The refusal branch cleared `pendingCompletion` ("leave the goal active",
v0.34.59 comment) but did **not** flip `status` back from `auditing` to
`active`. `scheduleContinuation(liveCtx, true)` then scheduled a send that
`sendContinuation` silently dropped: `isActionableGoal()` requires
`status === "active"` (goal.ts:2300). Result: status auditing, no claim, no
in-flight audit, nothing ever sending. 90s later the heartbeat's
stranded-audit recovery (goal.ts ~1887, the correct backstop for genuine
orphans) parked the goal `paused/blocked` "completion audit interrupted — no
verdict". autoResume covers only `active`-with-`interruptedAt` parks (goal.ts
~1117), not this blocked pause → **7h33m of silence** until a manual
`/list resume`. That is the "didn't continue".

### The two fixes (v0.34.74)

```ts
// Fix A — canonical normalized guard
if (result.goalRevision && !isGoalRevisionCurrent(result.goalRevision, state.goal)) {

// Fix B — refusal restores the actionable status
updateGoal({ ...(state.goal?.status === "auditing" ? { status: "active" } : {}),
             pendingCompletion: undefined }, liveCtx);
scheduleContinuation(liveCtx, true);
```

With Fix A, the incident's verdict applies (0 === 0) and the goal completes at
01:47 instead of stranding. With Fix B, even a GENUINE refusal (contract
moved — 3 vs 4) no longer dead-ends: the goal returns to active and the
scheduled continuation sends, so the loop keeps driving the current objective
and the user's only action is the advisory `/goal verify` to re-audit. The
stranded-audit backstop remains for real orphans (process death without
recovery).

## Evidence

- `tests/interrupt-didnt-continue.test.ts` (6 tests): the incident case
  (undefined revision + captured 0 → current → verdict applies); bumped
  revisions still refuse; equal non-zero revisions stay current; source pins
  for Fix A (guard uses `isGoalRevisionCurrent`, raw comparison gone) and Fix
  B (refusal branch sets `status: "active"` + re-schedules the continuation);
  behavior-preservation pin (genuine orphans still park with the same
  message).
- Full suite green, `tsc` clean.
- Ledger timeline above is the repro: `python3` extraction of
  `junk-runner/.pi-glla/active.jsonl` filtered to goal `20260806215307-4irtlm`.
- The screenshot was read with the mmx vision CLI (v0.34.72 routing).
