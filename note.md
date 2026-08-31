# Now

The 2026-08-31 GLLA live-activity/resume audit is closed. Activity cleanup,
active-idle `/glla resume`, eager auditor recovery, and the screenshot-shaped
queue behavior are documented in `audit/LIVE-ACTIVITY-AND-RESUME-2026-08-31.md`.

# Next

## safely parked should be active

Status: GLLA-owned stale activity is fixed with epoch/scope cleanup and
behavioral coverage. The original screenshot remains evidence, not an open
repro.

/home/dracon/Pictures/Screenshots/Screenshot_20260831_131506.png

## cant resume idle with /glla resume, i had to reload

Status: reproduced successfully through real `pi --mode rpc` in a fresh
`PI_OFFLINE=1` host; `/glla resume` emitted the active-idle re-kick, persisted
`resume_rekick`, and reached the normal start events. The pipe-to-PTY capture
was inconclusive, but no GLLA source defect remains identified.

Yea, `/glla resume` not starting was a common report.

## we are changing the recommend subagents extension to the one we are using right now and adjusting our compatibility if needed

Status: deferred. The checked-out GLLA repository uses `pi-subagents` 0.62.0,
but the separate `recommend-subagents` source is not present here. Revisit
when that source/package is available.

## auditor should be retry agerly too, currently we give up easy

Status: uniform eager retry and bounded fallback behavior are verified,
including billing/insufficient-balance-style provider errors.

/home/dracon/Pictures/Screenshots/Screenshot_20260831_223739.png

## insufficient balance seems like an obvious give up but it just shows that errosr can be wrong and we shold retry

Status: provider wording no longer suppresses the generic recovery chain; the
raw provider condition remains an external dependency.

/home/dracon/Pictures/Screenshot_20260831_223758.png

## lists are bugged, they dont keep going say nothing to resume

Status: no GLLA-owned queue stall was reproduced. A standalone goal archive
intentionally leaves waiting items for explicit `/list next`; list completion
promotes its successor. Keep the screenshot-linked ledger sequence as a
follow-up if the symptom recurs.

/home/dracon/Pictures/Screenshot_20260831_233920.png

# Later

## Cross-harness and extension review

Review other harnesses and goal extensions, notably pi goal x, DeepSeek, Codex, Claude, Antigravity, and Grok harnesses.

## NVIDIA AVO

There are related PRs, but they may be incomplete. Revisit after the current GLLA-owned work is prioritized:
https://github.com/DraconDev/pi-goal-list-loop-audit/pulls

# Idea
