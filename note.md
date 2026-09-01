# Now

## 2026-08-31 GLLA live-activity/resume audit — completed

The GLLA-owned stale activity issue is fixed with epoch/scope cleanup and
behavioral coverage. The original screenshot remains evidence, not an open
reproduction.

The active-idle `/glla resume` report was reproduced through real
`pi --mode rpc` in a fresh `PI_OFFLINE=1` host. It emitted the re-kick message,
persisted `resume_rekick`, and reached the normal start events. The pipe-to-PTY
capture was inconclusive, but no GLLA source defect remains identified.

Auditor recovery now retries uniformly and eagerly, including
billing/insufficient-balance-style provider errors, while retaining bounded
fallback selection. Provider availability remains external.

The screenshot-shaped queue behavior was tested: standalone goal archives
intentionally leave waiting list items for explicit `/list next`, while list
completion promotes its successor.

Evidence:

- `audit/LIVE-ACTIVITY-AND-RESUME-2026-08-31.md`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260831_131506.png`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260831_223739.png`
- `/home/dracon/Pictures/Screenshots/Screenshot_20260831_223758.png`

# Next

## recommend-subagents compatibility

Still deferred. The checked-out GLLA repository uses `pi-subagents` 0.62.0,
but the separate `recommend-subagents` source/package is not available here.
Revisit when its actual source is supplied.

## queued-list stall reproduction

Still open as a diagnostic follow-up. No GLLA-owned queue stall was reproduced;
the screenshot is not linked to a durable ledger sequence identifying the
owning policy and blocking transition. Reinvestigate if the symptom recurs,
with the corresponding ledger and screenshot.

- `/home/dracon/Pictures/Screenshots/Screenshot_20260831_233920.png`
- `audit/LIST-STALL-REPRODUCTION-2026-08-29.md`

# Later

## Cross-harness and extension review

Review other harnesses and goal extensions, notably pi Goal X, DeepSeek,
Codex, Claude, Antigravity, and Grok harnesses.

## NVIDIA AVO

There are related PRs, but they may be incomplete. Revisit after the current
GLLA-owned work is prioritized:
https://github.com/DraconDev/pi-goal-list-loop-audit/pulls

# Idea
