# Goal-Commands + Goal-Loop Extraction — v0.34.110 (decomposition step 2)

Second extraction from the 11,415-line goal.ts monolith per
`docs/GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md` sequencing
("2. Extract goal-commands.ts + goal-loop.ts — the biggest remaining
win: /goal, /list, /glla, /loop surface minus the machinery").

verification: bun test → 1146 pass / 1 skip / 0 fail (103 files);
`tsc --noEmit` clean; version 0.34.110. Zero behavior change: moved
bodies are byte-identical except mechanical accessor re-spellings
(`flags.X` getter/setter indirection for flags whose ownership stays in
goal.ts, and `loopTimer === null` → `!loopTimerPending()` for the 5
reads of the timer flag whose setter lives in goal-loop.ts).

## What moved

New modules (one-way imports only: goal.ts → goal-commands.ts →
goal-loop.ts; neither new file imports goal.ts):

- `extensions/goal-commands.ts` (1,991 lines) — the command surface:
  `createGoalCommands(deps)` factory + mirrored bare exports
  (cmdResume, cmdCancel, cmdList, cmdSettings, cmdGllaWipe/
  cmdGllaResume/cmdGllaStatus/cmdLog/cmdSet/cmdToolOverride,
  cmdReviewerSettings, maybeDecisionPopup, addSingleItem, enqueueItems,
  recentlyCompletedObjectives, probeAutoNotify, `Unknown /glla action`,
  list_settings_redirect, list_autoactivation_held, list_duplicate_skipped,
  the stale-entry gates, subtask validation refusals).
- `extensions/goal-loop.ts` (1,071 lines) — the loop machinery:
  `createGoalLoop(deps)` factory + mirrors (sendLoopTurn, runLoopTick,
  finishLoopGit, cmdLoop incl. `/loop finish`, startLoopFromConfig,
  deferred baseline, spec_item_progress accounting, divergence walk,
  loop rearm/backoff sites, `isLoopResumable` stalled-check,
  `loopTimerPending()` helper, STALE_TOOL_CONTEXT_MESSAGE).

goal.ts shrank 11,415 → 8,643 lines; everything else (registerCommand
descriptions/completions, tool defs, tools band, heartbeat, continuation,
auditor, reviewer call sites, session_compact hook) stays in place.

## Mechanical re-spellings (only these differ from the original bodies)

- Loop flags stay owned in goal.ts; goal-loop.ts reads/writes them through
  a `LoopFlags` accessor object: `loopRearmStreak` → `flags.loopRearmStreak`,
  `loopRearmSince` → `flags.loopRearmSince`, etc. Command flags likewise.
- `loopTimer === null` reads outside goal-loop.ts → `!loopTimerPending()`
  (helper exported from goal-loop.ts so the staying code never reads the
  moved timer binding directly).

## Test pins

66 test names broke on source pins; all re-anchored mechanically (file
reads re-pointed SRC→CMDS/LOOP per pin, regex literals re-spelled, flag
accessors re-spelled) — no expectation edits, no behavioral assertions
touched. Mixed-pin tests (e.g. stall-handling, list-subtasks,
pause-informativeness) now read two or three sources and pin each piece
where it lives. 16 test files were touched.

## Contract verification

- Moved handler/loop function names absent from goal.ts (grep -c = 0 for
  all 17 listed names).
- No `from ".../goal"` import in goal-commands.ts or goal-loop.ts (0).
- `createGoalCommands` wired in both goal.ts and goal-commands.ts.
- Ledger event names unchanged: loop_turn_sent / loop_turn_send_failed
  now emitted from goal-loop.ts; goal_continuation_* / draft_duplicate_skipped /
  stacked_state_auto_arbitrated / session_compact / compaction_refire /
  compaction_grace_refire stay in goal.ts; list_duplicate_skipped emitted
  from goal-commands.ts. Every name byte-identical to v0.34.109.
- Both new files ≤ 2,000 lines (1,991 / 1,071); goal.ts at 8,643.
