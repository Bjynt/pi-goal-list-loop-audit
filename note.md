# Next

## 1. Obtain and assess `recommend-subagents`

- Obtain the actual source or package.
- Compare its API and lifecycle with the current GLLA integration.
- Decide whether to adapt GLLA to current `pi-subagents` or replace the
  unavailable legacy AgentManager path.
- Keep external packages unchanged; prove any GLLA change with behavioral
  coverage.

## 2. Reproduce the queued-list symptom only with fresh evidence

If the symptom recurs, capture the screenshot-linked ledger, active/list
state, and transition sequence. Distinguish a standalone goal archive that
requires explicit `/list next` from a list-policy successor that should
promote automatically. Change GLLA only if a GLLA-owned blocking transition is
proven.

- `/home/dracon/Pictures/Screenshots/Screenshot_20260831_233920.png`
- `audit/LIST-STALL-REPRODUCTION-2026-08-29.md`

## 3. Perform the cross-harness review

Review pi Goal X, DeepSeek, Codex, Claude, Antigravity, and Grok harnesses and
related goal extensions. Compare recovery, queue, supervision, and persistence
behavior, then record only actionable GLLA-owned differences.

## 4. Review NVIDIA AVO

Assess whether the related PRs are complete and relevant after the higher-
priority GLLA work:

https://github.com/DraconDev/pi-goal-list-loop-audit/pulls
