# REPLACE-RESUME-INTENT — GitHub #6 (v0.34.103)

Field report filed by the detached auditor (talosu) 2026-08-08, GitHub
issue #6: two defects around goal replacement and resume feedback.

verification: bun test tests/replace-resume-intent.test.ts tests/resume-rekick.test.ts tests/mode-command-guidance.test.ts → 17 pass / 0 fail; full suite 1130 pass / 1 skip / 0 fail (101 files); npx tsc --noEmit clean; version 0.34.103.

## Defect A — replacing a `wait` goal silently cancels its scheduled resume

Repro: goal A parked in `wait` (pauseResumeAt set — "auto-resume later");
user inserts higher-priority goal B (`/list next` → list-cascade
`goal_created` → `setGoal`); setGoal archived A as `aborted` via
`archiveCurrentGoal` and A's resume intent disappeared with zero notice.
The user's "it will come back / can be resumed" expectation broke silently.

Fix (extensions/loops/goal.ts, `setGoal` replace branch): capture the
superseded goal BEFORE archiving; if `pauseResumeAt` was set, warn
(`Goal [id]: <objective> was superseded and archived — its scheduled
auto-resume (HH:MM) was cancelled. /goal <objective> to recreate it.`),
ledger `replaced_resume_cancelled` {goalId, policy, scheduledAt,
replacedBy}, and notifyExternal. Plain replaces without a resume intent
stay quiet — no new spam.

## Defect B — `/goal resume` silently no-ops on archived goals

The bare `if (!state.goal || state.goal.status !== "paused") return;`
swallowed the verb with no feedback for archived (complete/aborted),
missing, or other non-paused states.

Fix (`cmdResume`): every dead end now answers:
- terminal (complete/aborted → archived): warning naming the state and the
  real recovery path — `/goal <objective>` fresh start + `/goal archive`
  (goal policy), `/list add <objective>` re-queue + `/list show` (list
  policy);
- no goal at all: "Nothing to resume — no goal is active or paused" plus
  `/goal <objective>` / `/list show` / `/loop resume` when a loop is
  active;
- other non-paused states: informational answer via the mode-aware
  `activeGoalStatusCommand()` (no hardcoded /goal literals — the
  mode-command-guidance contract holds).

## Tests

- tests/replace-resume-intent.test.ts (new, 5 tests): Defect A warn+ledger
  gate, quiet plain-replace, Defect B terminal/no-goal answers, wiring.
- tests/resume-rekick.test.ts: updated the v0.34.3 pin — the re-kick still
  precedes the paused-only guard; the old silent bare-return literal is
  asserted gone.
- tests/mode-command-guidance.test.ts: still green (no hardcoded /goal
  guidance literals introduced).

## Ship

- version 0.34.103, CHANGELOG entry, tag v0.34.103, symlink
  v0.34.103-REPLACE-RESUME-INTENT.md → REPLACE-RESUME-INTENT-2026-08-08.md,
  this doc carries the literal `verification:` marker.
