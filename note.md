# Now

## 1. Obtain and assess `recommend-subagents`

- Obtain the actual source or package.
- Compare its API and lifecycle with the current GLLA integration.
- Decide whether to adapt GLLA to current `pi-subagents` or replace the
  unavailable legacy AgentManager path.
- Keep external packages unchanged; prove any GLLA change with behavioral
  coverage.

## 2. Confirm the continuous queue fix in a live host

The GLLA-owned gap is fixed: successful standalone completion hands off to an
already-waiting list, and `/glla resume` hydrates/starts a waiting-only queue.
Confirm the screenshot-shaped path in a live host when provider conditions
permit, capturing the ledger transition if it recurs. Cold-load automation
remains explicit-consent gated.

- `/home/dracon/Pictures/Screenshots/Screenshot_20260901_105419.png`
- `audit/LIST-CONTINUOUS-HANDOFF-2026-09-01.md`

# Next 

## https://github.com/DraconDev/pi-goal-list-loop-audit/pull/39

# Later 

## Perform the cross-harness review

Review pi Goal X, DeepSeek, Codex, Claude, Antigravity, and Grok harnesses and
related goal extensions. Compare recovery, queue, supervision, and persistence
behavior, then record only actionable GLLA-owned differences.

## Review NVIDIA AVO

Assess whether the related PRs are complete and relevant after the higher-
priority GLLA work:

https://github.com/DraconDev/pi-goal-list-loop-audit/pulls
